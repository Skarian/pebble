package com.skarian.airquality

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
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume

class AirQualityPebbleService : BasePebbleListenerService() {
    override val coroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val latestRequest = AtomicInteger(0)
    private val appUuid = UUID.fromString(PebbleProtocol.APP_UUID)

    override suspend fun onMessageReceived(
        watchappUUID: UUID,
        data: PebbleDictionary,
        watch: WatchIdentifier,
    ): ReceiveResult {
        if (watchappUUID != appUuid) return ReceiveResult.Nack
        if (PebbleProtocol.number(data, PebbleProtocol.COMMAND) != PebbleProtocol.COMMAND_FETCH) {
            return ReceiveResult.Ack
        }
        val requestId = PebbleProtocol.number(data, PebbleProtocol.REQUEST_ID) ?: return ReceiveResult.Nack
        latestRequest.set(requestId)
        coroutineScope.launch { refreshAndSend(requestId, watch) }
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

    private suspend fun refreshAndSend(requestId: Int, watch: WatchIdentifier) {
        val settings = CompanionSettings(this)
        val address = settings.sensorAddress
        if (address.isNullOrBlank()) {
            sendIfCurrent(requestId, PebbleProtocol.status(PebbleProtocol.STATUS_SETUP, requestId), watch)
            return
        }
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

        val store = ReadingStore(this)
        store.save(reading)
        val now = Instant.now().epochSecond
        val snapshot = store.snapshot(address, settings.watchName, now)
        store.close()
        if (snapshot == null) {
            send(PebbleProtocol.status(PebbleProtocol.STATUS_SERVICE, requestId), watch)
            return
        }
        sendIfCurrent(requestId, PebbleProtocol.snapshot(snapshot, requestId, now), watch)
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
}
