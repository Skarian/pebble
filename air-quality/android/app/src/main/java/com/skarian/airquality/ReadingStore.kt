package com.skarian.airquality

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class ReadingStore(context: Context) : SQLiteOpenHelper(context, "airquality-readings.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE readings (
                observed_at INTEGER NOT NULL,
                address TEXT NOT NULL,
                device_name TEXT NOT NULL,
                co2 INTEGER NOT NULL,
                temperature_x10 INTEGER NOT NULL,
                humidity_x10 INTEGER NOT NULL,
                pressure_x10 INTEGER NOT NULL,
                battery INTEGER NOT NULL,
                co2_state INTEGER NOT NULL,
                PRIMARY KEY (address, observed_at)
            )""".trimIndent()
        )
        db.execSQL("CREATE INDEX readings_recent ON readings(address, observed_at DESC)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    @Synchronized
    fun save(reading: AranetReading) {
        writableDatabase.insertWithOnConflict(
            "readings", null, values(reading), SQLiteDatabase.CONFLICT_REPLACE,
        )
        writableDatabase.delete(
            "readings",
            "observed_at < ?",
            arrayOf((reading.observedAtEpochSeconds - 8L * 24 * 60 * 60).toString()),
        )
    }

    @Synchronized
    fun saveAll(readings: List<AranetReading>) {
        if (readings.isEmpty()) return
        writableDatabase.beginTransaction()
        try {
            readings.forEach { reading ->
                writableDatabase.insertWithOnConflict(
                    "readings", null, values(reading), SQLiteDatabase.CONFLICT_REPLACE,
                )
            }
            val newest = readings.maxOf { it.observedAtEpochSeconds }
            writableDatabase.delete(
                "readings", "observed_at < ?",
                arrayOf((newest - 8L * 24 * 60 * 60).toString()),
            )
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    @Synchronized
    fun readings(address: String, sinceEpochSeconds: Long): List<AranetReading> {
        val result = mutableListOf<AranetReading>()
        val cursor = readableDatabase.query(
            "readings", null, "address = ? AND observed_at >= ?",
            arrayOf(address, sinceEpochSeconds.toString()), null, null, "observed_at ASC",
        )
        cursor.use {
            while (cursor.moveToNext()) {
                result += AranetReading(
                    address = cursor.getString(cursor.getColumnIndexOrThrow("address")),
                    deviceName = cursor.getString(cursor.getColumnIndexOrThrow("device_name")),
                    observedAtEpochSeconds = cursor.getLong(cursor.getColumnIndexOrThrow("observed_at")),
                    co2Ppm = cursor.getInt(cursor.getColumnIndexOrThrow("co2")),
                    temperatureX10 = cursor.getInt(cursor.getColumnIndexOrThrow("temperature_x10")),
                    humidityX10 = cursor.getInt(cursor.getColumnIndexOrThrow("humidity_x10")),
                    pressureX10 = cursor.getInt(cursor.getColumnIndexOrThrow("pressure_x10")),
                    batteryPercent = cursor.getInt(cursor.getColumnIndexOrThrow("battery")),
                    co2State = cursor.getInt(cursor.getColumnIndexOrThrow("co2_state")),
                )
            }
        }
        return result
    }

    fun snapshot(
        address: String,
        location: String,
        nowEpochSeconds: Long,
        scale: ChartScale = ChartScale.HOUR,
    ): AirSnapshot? =
        SnapshotAggregator.build(
            readings(address, nowEpochSeconds - 8L * 24 * 60 * 60),
            location,
            nowEpochSeconds,
            scale,
        )

    private fun values(reading: AranetReading): ContentValues = ContentValues().apply {
        put("observed_at", reading.observedAtEpochSeconds)
        put("address", reading.address)
        put("device_name", reading.deviceName)
        put("co2", reading.co2Ppm)
        put("temperature_x10", reading.temperatureX10)
        put("humidity_x10", reading.humidityX10)
        put("pressure_x10", reading.pressureX10)
        put("battery", reading.batteryPercent)
        put("co2_state", reading.co2State)
    }
}
