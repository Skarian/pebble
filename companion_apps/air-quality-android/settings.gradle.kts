pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "AirQualityCompanion"
include(":app", ":pebble-appmessage", ":pebble-errors")
project(":pebble-appmessage").projectDir = file("../../shared/appmessage/android")
project(":pebble-errors").projectDir = file("../../shared/errors/android")
