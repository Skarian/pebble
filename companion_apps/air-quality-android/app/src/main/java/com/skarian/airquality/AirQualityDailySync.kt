package com.skarian.airquality

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

class AirQualityDailySync(context: Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {

    override suspend fun doWork(): Result {
        val settings = CompanionSettings(applicationContext)
        val address = settings.sensorAddress ?: run {
            Log.i(LOG_TAG, "Daily sync skipped: no sensor selected")
            return Result.success()
        }
        settings.lastDailySyncAttemptAt = Instant.now().epochSecond
        Log.i(LOG_TAG, "Daily sync started")
        val scanner = AranetScanner(applicationContext)
        if (!scanner.hasPermissions()) {
            Log.w(LOG_TAG, "Daily sync skipped: Nearby devices permission unavailable")
            return Result.success()
        }
        if (!scanner.bluetoothEnabled()) {
            Log.w(LOG_TAG, "Daily sync skipped: Bluetooth unavailable")
            return Result.success()
        }

        val reading = suspendCancellableCoroutine<AranetReading?> { continuation ->
            scanner.readOnce(address) { value ->
                if (continuation.isActive) continuation.resume(value)
            }
        } ?: run {
            Log.w(LOG_TAG, "Daily sync did not find the selected sensor")
            return Result.success()
        }

        ReadingStore(applicationContext).use { it.save(reading) }
        settings.lastDailySyncSuccessAt = Instant.now().epochSecond
        Log.i(LOG_TAG, "Daily sync saved a fresh reading")
        val now = Instant.now().epochSecond
        val lookbackSeconds = ReadingStore(applicationContext).use {
            it.requiredHistoryLookbackSeconds(address, now, ChartScale.WEEK.windowSeconds)
        } ?: return Result.success()

        val history = suspendCancellableCoroutine<kotlin.Result<List<AranetReading>>> { continuation ->
            AranetHistoryReader(applicationContext).import(
                address = address,
                deviceName = reading.deviceName,
                batteryPercent = reading.batteryPercent,
                co2State = reading.co2State,
                lookbackSeconds = lookbackSeconds,
            ) { result ->
                if (continuation.isActive) continuation.resume(result)
            }
        }
        history.onSuccess { readings ->
            ReadingStore(applicationContext).use { it.saveAll(readings) }
            Log.i(LOG_TAG, "Daily sync repaired missing history")
        }.onFailure { error ->
            Log.w(LOG_TAG, "Daily sync history repair failed: ${error.message}")
        }
        return Result.success()
    }

    companion object {
        private const val LOG_TAG = "AirQualityDailySync"
        private const val UNIQUE_WORK = "airquality-daily-sync"

        fun schedule(context: Context) {
            if (CompanionSettings(context).sensorAddress.isNullOrBlank()) return
            val request = PeriodicWorkRequestBuilder<AirQualityDailySync>(24, TimeUnit.HOURS)
                .setInitialDelay(24, TimeUnit.HOURS)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_WORK,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }
}
