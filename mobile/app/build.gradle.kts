plugins {
    id("com.android.application")
}

android {
    namespace = "com.luiz.samaritano"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.luiz.samaritano"
        minSdk = 28
        targetSdk = 35
        versionCode = 4
        versionName = "0.3.1"
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
}
