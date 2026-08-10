import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.skarian.agentscompanion"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.skarian.agentscompanion"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        jniLibs.excludes += setOf("lib/*/libtermux.so", "lib/*/liblocal-socket.so")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

configurations.configureEach {
    // termux-shared brings Guava, which already contains this compatibility class.
    exclude(group = "com.google.guava", module = "listenablefuture")
}

dependencies {
    implementation(project(":pebble-appmessage"))
    implementation("androidx.activity:activity-ktx:1.12.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.10.0")
    implementation("com.github.termux.termux-app:termux-shared:0.118.1")
    implementation("io.rebble.pebblekit2:client:1.2.0")
    implementation("org.json:json:20250517")
    testImplementation("junit:junit:4.13.2")
}
