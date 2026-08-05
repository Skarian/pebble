package com.skarian.agentscompanion

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat

object CompanionNotifications {
    const val TURN_CHANNEL_ID = "agent_turns"
    const val ACTIVE_NOTIFICATION_ID = 41
    private const val RESULT_NOTIFICATION_ID = 42

    fun createChannel(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(TURN_CHANNEL_ID, "Agent turns", NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    fun active(context: Context, message: String) = base(context, message)
        .setOngoing(true)
        .build()

    fun showResult(context: Context, title: String, message: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) return
        createChannel(context)
        context.getSystemService(NotificationManager::class.java).notify(
            RESULT_NOTIFICATION_ID,
            base(context, message).setContentTitle(title).setAutoCancel(true).build(),
        )
    }

    private fun base(context: Context, message: String) =
        NotificationCompat.Builder(context, TURN_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_agents)
            .setContentTitle("Agents")
            .setContentText(message.take(180))
            .setStyle(NotificationCompat.BigTextStyle().bigText(message.take(1200)))
            .setContentIntent(
                PendingIntent.getActivity(
                    context,
                    0,
                    Intent(context, MainActivity::class.java),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
}
