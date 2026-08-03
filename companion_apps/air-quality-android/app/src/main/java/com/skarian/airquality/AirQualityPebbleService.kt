package com.skarian.airquality

import android.util.Log
import io.rebble.pebblekit2.client.BasePebbleListenerService
import io.rebble.pebblekit2.client.DefaultPebbleSender
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.ReceiveResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume

class AirQualityPebbleService : BasePebbleListenerService() {
    override val coroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val latestRequest = AtomicInteger(0)
    private val appUuid = UUID.fromString(PebbleProtocol.APP_UUID)
    private val historyMutex = Mutex()

    override suspend fun onMessageReceived(
        watchappUUID: UUID,
        data: PebbleDictionary,
        watch: WatchIdentifier,
    ): ReceiveResult {
        if (watchappUUID != appUuid) return ReceiveResult.Nack
        if (PebbleProtocol.number(data, PebbleProtocol.PROTOCOL) != PebbleProtocol.PROTOCOL_VERSION) {
            return ReceiveResult.Nack
        }
        AirQualityDailySync.schedule(this)
        val command = PebbleProtocol.number(data, PebbleProtocol.COMMAND)
        if (command != PebbleProtocol.COMMAND_FETCH && command != PebbleProtocol.COMMAND_SCALE) {
            return ReceiveResult.Ack
        }
        val requestId = PebbleProtocol.number(data, PebbleProtocol.REQUEST_ID) ?: return ReceiveResult.Nack
        val scale = ChartScale.fromWire(PebbleProtocol.number(data, PebbleProtocol.SCALE))
        latestRequest.set(requestId)
        coroutineScope.launch {
            refreshAndSend(requestId, watch, scale, command == PebbleProtocol.COMMAND_FETCH)
        }
        return ReceiveResult.Ack
    }

    override fun onAppOpened(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID != appUuid) return
        coroutineScope.launch { send(PebbleProtocol.phoneReady(), watch) }
    }

    override fun onDestroy() {
        coroutineScope.cancel()
        super.onDestroy()
    }

    private suspend fun refreshAndSend(
        requestId: Int,
        watch: WatchIdentifier,
        scale: ChartScale,
        refreshSensor: Boolean,
    ) {
        val settings = CompanionSettings(this)
        val address = settings.sensorAddress
        if (address.isNullOrBlank()) {
            sendIfCurrent(requestId, PebbleProtocol.status(PebbleProtocol.STATUS_SETUP, requestId), watch)
            return
        }
        backfillHistoryIfNeeded(address, settings.watchName, scale)
        if (latestRequest.get() != requestId) return
        if (refreshSensor) {
            val scanner = AranetScanner(this)
            if (!scanner.hasPermissions()) {
                sendIfCurrent(requestId, PebbleProtocol.status(PebbleProtocol.STATUS_PERMISSION, requestId), watch)
                return
            }
            if (!scanner.bluetoothEnabled()) {
                sendIfCurrent(requestId, PebbleProtocol.status(PebbleProtocol.STATUS_BLUETOOTH, requestId), watch)
                return
            }

            val reading = suspendCancellableCoroutine { continuation ->
                scanner.readOnce(address) { result ->
                    if (continuation.isActive) continuation.resume(result)
                }
            }
            if (latestRequest.get() != requestId) return
            if (reading == null) {
                send(PebbleProtocol.status(PebbleProtocol.STATUS_SENSOR, requestId), watch)
                return
            }
            ReadingStore(this).use { it.save(reading) }
        }

        val now = Instant.now().epochSecond
        val snapshot = ReadingStore(this).use {
            it.snapshot(address, settings.watchName, now, scale)
        }
        if (snapshot == null) {
            send(PebbleProtocol.status(PebbleProtocol.STATUS_SERVICE, requestId), watch)
            return
        }
        sendIfCurrent(requestId, PebbleProtocol.snapshot(snapshot, requestId, now), watch)
    }

    private suspend fun backfillHistoryIfNeeded(
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
        }.onFailure { error ->
            Log.w(HISTORY_LOG_TAG, "Automatic history backfill failed: ${error.message}")
        }
    }

    private suspend fun sendIfCurrent(
        requestId: Int,
        data: PebbleDictionary,
        watch: WatchIdentifier,
    ) {
        if (latestRequest.get() == requestId) send(data, watch)
    }

    private suspend fun send(data: PebbleDictionary, watch: WatchIdentifier) {
        val sender = DefaultPebbleSender(applicationContext)
        try {
            sender.sendDataToPebble(appUuid, data, listOf(watch))
        } finally {
            sender.close()
        }
    }

    companion object {
        private const val HISTORY_LOG_TAG = "AirQualityHistory"
    }
}
