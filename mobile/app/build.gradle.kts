plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.luiz.samaritano"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.luiz.samaritano"
        minSdk = 28
        targetSdk = 35
        versionCode = 8
        versionName = "0.4.3"
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

    packaging {
        jniLibs.useLegacyPackaging = true
    }
}

dependencies {
    implementation(project(":llama"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
}
