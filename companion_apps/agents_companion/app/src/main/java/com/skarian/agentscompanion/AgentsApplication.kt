package com.skarian.agentscompanion

import android.app.Application

class AgentsApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        agentsErrorReporter(this)
    }
}
