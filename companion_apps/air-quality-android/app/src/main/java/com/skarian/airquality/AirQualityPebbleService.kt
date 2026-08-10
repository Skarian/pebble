package com.skarian.airquality

import android.util.Log
import com.skarian.pebble.appmessage.AppMessageSession
import io.rebble.pebblekit2.client.BasePebbleListenerService
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.ReceiveResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
import java.time.Instant
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class AirQualityPebbleService : BasePebbleListenerService() {
    override val coroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val appUuid = UUID.fromString(PebbleProtocol.APP_UUID)
    private val historyMutex = Mutex()
    private val appMessages by lazy { appMessageSession(this) }
    private val requestPipeline by lazy {
        AirQualityRequestPipeline(
            cachedResponse = ::cachedResponse,
            liveResponse = ::liveResponse,
            liveFailureResponse = ::liveFailureResponse,
            deliver = ::deliverResponse,
            deliverReplay = ::deliverReplay,
            scheduleHistoryRepair = ::scheduleHistoryRepair,
        )
    }
    override suspend fun onMessageReceived(
        watchappUUID: UUID,
        data: PebbleDictionary,
        watch: WatchIdentifier,
    ): ReceiveResult {
        if (watchappUUID != appUuid) return ReceiveResult.Nack
        if (PebbleProtocol.number(data, PebbleProtocol.PROTOCOL) != PebbleProtocol.PROTOCOL_VERSION) {
            return ReceiveResult.Nack
        }
        val command = PebbleProtocol.number(data, PebbleProtocol.COMMAND)
        if (command != PebbleProtocol.COMMAND_FETCH && command != PebbleProtocol.COMMAND_SCALE) {
            return ReceiveResult.Ack
        }
        val requestId = PebbleProtocol.number(data, PebbleProtocol.REQUEST_ID) ?: return ReceiveResult.Nack
        val request = AirQualityRequest(
            requestId = requestId,
            command = command,
            scale = ChartScale.fromWire(PebbleProtocol.number(data, PebbleProtocol.SCALE)),
            watchId = watch.value,
        )
        AirQualityDailySync.schedule(this)
        appMessages.messageReceived(watch.value, operation(request), request.requestId.toString())

        val admission = appMessages.beginRead(
            watch.value,
            READ_OPERATION,
            request.requestId.toString(),
            "${request.command}:${request.scale.name}",
        )
        admission.launch(coroutineScope) {
            try {
                val responses = requestPipeline.execute(request)
                if (responses.isNotEmpty()) {
                    appMessages.completeRead(
                        request.watchId,
                        READ_OPERATION,
                        request.requestId.toString(),
                    ) {
                        requestPipeline.replay(request, responses)
                    }
                } else {
                    appMessages.abandonRead(
                        request.watchId, READ_OPERATION, request.requestId.toString(),
                    )
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                appMessages.abandonRead(
                    request.watchId, READ_OPERATION, request.requestId.toString(),
                )
                throw cancelled
            } catch (_: Throwable) {
                appMessages.abandonRead(
                    request.watchId, READ_OPERATION, request.requestId.toString(),
                )
                record(request, operation(request), "domain_failure", "request_failed")
            }
        }
        return if (admission.status == AppMessageSession.ReadStatus.CONFLICT) {
            ReceiveResult.Nack
        } else {
            ReceiveResult.Ack
        }
    }

    override fun onAppOpened(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID != appUuid) return
        appMessages.open(watch.value)
        coroutineScope.launch {
            appMessages.announceReady(watch.value, PebbleProtocol.phoneReady())
        }
    }

    override fun onAppClosed(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID != appUuid) return
        appMessages.close(watch.value)
    }

    override fun onDestroy() {
        coroutineScope.cancel()
        super.onDestroy()
    }

    private suspend fun cachedResponse(request: AirQualityRequest): AirQualityResponse? {
        val settings = CompanionSettings(this)
        val address = settings.sensorAddress
        if (address.isNullOrBlank()) {
            return domainResponse(
                request,
                operation = "setup",
                status = PebbleProtocol.STATUS_SETUP,
                category = "setup",
            )
        }
        val now = Instant.now().epochSecond
        val snapshot = ReadingStore(this).use {
            it.snapshot(address, settings.watchName, now, request.scale)
        }
        if (snapshot != null) {
            record(request, "cached_snapshot", "cached_response")
            return AirQualityResponse(
                operation = "cached_snapshot",
                data = PebbleProtocol.snapshot(snapshot, request.requestId, now, cached = true),
            )
        }
        if (request.command == PebbleProtocol.COMMAND_SCALE) {
            return domainResponse(
                request,
                operation = "scale_snapshot",
                status = PebbleProtocol.STATUS_SERVICE,
                category = "no_cached_data",
            )
        }
        return null
    }

    private suspend fun liveResponse(request: AirQualityRequest): AirQualityResponse {
        val settings = CompanionSettings(this)
        val address = settings.sensorAddress?.takeUnless(String::isBlank)
            ?: return domainResponse(request, "live_scan", PebbleProtocol.STATUS_SETUP, "setup")
        val scanner = AranetScanner(this)
        if (!scanner.hasPermissions()) {
            return domainResponse(request, "live_scan", PebbleProtocol.STATUS_PERMISSION, "permission")
        }
        if (!scanner.bluetoothEnabled()) {
            return domainResponse(
                request, "live_scan", PebbleProtocol.STATUS_BLUETOOTH, "bluetooth_off",
            )
        }

        record(request, "live_scan", "scan_started")
        val reading = suspendCancellableCoroutine { continuation ->
            val cancelScan = scanner.readOnce(address) { result ->
                if (continuation.isActive) continuation.resume(result)
            }
            continuation.invokeOnCancellation { cancelScan() }
        }
        if (reading == null) {
            return domainResponse(
                request, "live_scan", PebbleProtocol.STATUS_SENSOR, "sensor_unavailable",
            )
        }
        ReadingStore(this).use { it.save(reading) }

        val now = Instant.now().epochSecond
        val snapshot = ReadingStore(this).use {
            it.snapshot(address, settings.watchName, now, request.scale)
        } ?: return domainResponse(
            request, "live_snapshot", PebbleProtocol.STATUS_SERVICE, "snapshot_unavailable",
        )
        record(request, "live_scan", "scan_succeeded", finalCategory = "ok")
        return AirQualityResponse(
            operation = "live_snapshot",
            data = PebbleProtocol.snapshot(snapshot, request.requestId, now),
        )
    }

    private suspend fun liveFailureResponse(request: AirQualityRequest): AirQualityResponse = domainResponse(
        request = request,
        operation = "live_scan",
        status = PebbleProtocol.STATUS_SERVICE,
        category = "live_failure",
    )

    private suspend fun deliverResponse(request: AirQualityRequest, response: AirQualityResponse) {
        appMessages.send(
            request.watchId,
            response.operation,
            request.requestId.toString(),
            response.data,
        )
    }

    private suspend fun deliverReplay(
        request: AirQualityRequest,
        responses: List<AirQualityResponse>,
    ) {
        appMessages.sendBatch(
            request.watchId,
            "response_replay",
            request.requestId.toString(),
            responses.map { it.data },
        )
    }

    private fun scheduleHistoryRepair(request: AirQualityRequest) {
        coroutineScope.launch {
            val settings = CompanionSettings(this@AirQualityPebbleService)
            val address = settings.sensorAddress?.takeUnless(String::isBlank) ?: return@launch
            record(request, "history_repair", "history_scheduled")
            backfillHistoryIfNeeded(request, address, settings.watchName, request.scale)
        }
    }

    private suspend fun backfillHistoryIfNeeded(
        request: AirQualityRequest,
        address: String,
        location: String,
        scale: ChartScale,
    ) = historyMutex.withLock {
        val scanner = AranetScanner(this)
        if (!scanner.hasPermissions() || !scanner.bluetoothEnabled()) return@withLock
        val now = Instant.now().epochSecond
        val (lookbackSeconds, current) = ReadingStore(this).use { store ->
            store.requiredHistoryLookbackSeconds(address, now, scale.windowSeconds) to
                store.snapshot(address, location, now, scale)?.current
        }
        if (lookbackSeconds == null || current == null) return@withLock
        record(request, "history_repair", "history_started")
        val result = suspendCancellableCoroutine<Result<List<AranetReading>>> { continuation ->
            AranetHistoryReader(applicationContext).import(
                address = address,
                deviceName = current.deviceName,
                batteryPercent = current.batteryPercent,
                co2State = current.co2State,
                lookbackSeconds = lookbackSeconds,
            ) { imported ->
                if (continuation.isActive) continuation.resume(imported)
            }
        }
        result.onSuccess { readings ->
            ReadingStore(this).use { it.saveAll(readings) }
            Log.i(HISTORY_LOG_TAG, "Backfilled ${readings.size} saved readings")
            record(request, "history_repair", "history_succeeded", finalCategory = "ok")
        }.onFailure {
            Log.w(HISTORY_LOG_TAG, "Automatic history backfill failed")
            record(
                request,
                "history_repair",
                "domain_failure",
                finalCategory = "history_unavailable",
            )
        }
    }

    private fun domainResponse(
        request: AirQualityRequest,
        operation: String,
        status: Int,
        category: String,
    ): AirQualityResponse {
        record(request, operation, "domain_failure", finalCategory = category)
        return AirQualityResponse(
            operation = operation,
            data = PebbleProtocol.status(status, request.requestId),
            domainCategory = category,
        )
    }

    private fun operation(request: AirQualityRequest): String =
        if (request.command == PebbleProtocol.COMMAND_SCALE) "scale" else "refresh"

    private fun record(
        request: AirQualityRequest,
        operation: String,
        event: String,
        finalCategory: String = "",
    ) {
        appMessages.record(
            operation,
            request.requestId.toString(),
            event,
            finalCategory,
            request.watchId,
        )
    }

    companion object {
        private const val APP_NAME = "air_quality"
        private const val HISTORY_LOG_TAG = "AirQualityHistory"
        private const val READ_OPERATION = "air_quality_read"

        fun appMessageSession(context: android.content.Context) = AppMessageSession(
            context.applicationContext,
            UUID.fromString(PebbleProtocol.APP_UUID),
            APP_NAME,
        )
    }
}
