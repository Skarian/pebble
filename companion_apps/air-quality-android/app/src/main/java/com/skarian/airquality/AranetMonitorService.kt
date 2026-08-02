package com.skarian.airquality

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder

class AranetMonitorService : Service() {
    private var scanner: AranetScanner? = null
    private var store: ReadingStore? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, notification("Waiting for Aranet4"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val settings = CompanionSettings(this)
        if (intent?.action == ACTION_STOP) {
            settings.monitoringEnabled = false
            stopSelf()
            return START_NOT_STICKY
        }
        val address = settings.sensorAddress
        if (!settings.monitoringEnabled || address.isNullOrBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        val nextScanner = AranetScanner(this)
        if (!nextScanner.hasPermissions() || !nextScanner.bluetoothEnabled()) {
            updateNotification("Open AirQuality on phone")
            return START_STICKY
        }
        scanner?.stopMonitoring()
        scanner = nextScanner
        if (store == null) store = ReadingStore(this)
        nextScanner.startMonitoring(address) { reading ->
            store?.save(reading)
            updateNotification("${reading.co2Ppm} ppm · ${settings.watchName}")
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scanner?.stopMonitoring()
        store?.close()
        scanner = null
        store = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "AirQuality monitoring", NotificationManager.IMPORTANCE_LOW),
        )
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    private fun notification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this, 1, Intent(this, AranetMonitorService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("AirQuality")
            .setContentText(text)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stopIntent).build())
            .build()
    }

    companion object {
        const val ACTION_STOP = "com.skarian.airquality.STOP"
        private const val CHANNEL_ID = "airquality-monitor"
        private const val NOTIFICATION_ID = 4102
    }
}
