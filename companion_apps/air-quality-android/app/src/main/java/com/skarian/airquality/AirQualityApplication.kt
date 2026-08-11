package com.skarian.airquality

import android.app.Application

class AirQualityApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        airErrorReporter(this)
    }
}
