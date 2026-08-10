package com.luiz.samaritano

import android.content.Context
import com.arm.aichat.AiChat
import com.arm.aichat.InferenceEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class OfflineLlm(context: Context) {
    fun interface Callback { fun complete(ok: Boolean, text: String) }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val engine = AiChat.getInferenceEngine(context.applicationContext)
    @Volatile private var loadedPath: String? = null
    @Volatile private var loadedConversationId: String? = null

    fun chat(modelPath: String, conversationId: String, systemPrompt: String, prompt: String, callback: Callback) {
        scope.launch {
            try {
                if (loadedPath != modelPath || loadedConversationId != conversationId) {
                    val initial = engine.state.first {
                        it is InferenceEngine.State.Initialized ||
                            it is InferenceEngine.State.ModelReady ||
                            it is InferenceEngine.State.Error
                    }
                    if (initial is InferenceEngine.State.Error) engine.cleanUp()
                    if (engine.state.value is InferenceEngine.State.ModelReady) engine.cleanUp()
                    engine.loadModel(modelPath)
                    engine.setSystemPrompt(systemPrompt)
                    loadedPath = modelPath
                    loadedConversationId = conversationId
                }
                val answer = StringBuilder()
                engine.sendUserPrompt("/no_think\n$prompt", 512).collect { answer.append(it) }
                val cleaned = answer.toString()
                    .replace(Regex("(?is)<think>.*?</think>"), "")
                    .replace(Regex("(?i)</?think>"), "")
                    .trim()
                callback.complete(true, cleaned)
            } catch (error: Exception) {
                callback.complete(false, error.message ?: error.javaClass.simpleName)
            }
        }
    }

    fun shutdown() {
        try { engine.destroy() } catch (_: Exception) {}
        scope.cancel()
    }
}
