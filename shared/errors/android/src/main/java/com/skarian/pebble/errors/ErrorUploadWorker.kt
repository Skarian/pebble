package com.skarian.pebble.errors

import android.content.Context
import android.util.Log
import androidx.work.*
import java.io.File
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import org.json.*
internal class ErrorUploadWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val config = runCatching { Preferences(applicationContext).read() }
            .onFailure { Log.e("PebbleErrors", "Error reporter settings are unreadable", it) }
            .getOrNull()?.takeIf(Config::usable) ?: return Result.success()
        val journal = ErrorJournal(FileStore(File(applicationContext.noBackupFilesDir, ErrorReporter.FILE)))
        val drained = runCatching { Uploader(journal, HttpsTransport(config.key), listOf(config.key)).drain() }
            .getOrElse { error ->
                Log.e("PebbleErrors", "Error upload worker failed", error)
                return Result.retry()
            }
        return when (drained) {
            Drain.COMPLETE -> Result.success()
            Drain.PERMANENT -> Result.failure()
            Drain.TRANSIENT -> Result.retry()
        }
    }
}
internal enum class Drain { COMPLETE, TRANSIENT, PERMANENT }
internal sealed interface UploadResult {
    data object Accepted : UploadResult
    data class Failed(val error: Any, val transient: Boolean) : UploadResult
}
internal fun interface UploadTransport { fun send(record: JSONObject): UploadResult }
internal class Uploader(private val journal: ErrorJournal, private val transport: UploadTransport,
                        private val secrets: Collection<String> = emptyList()) {
    fun drain(): Drain {
        repeat(32) {
            val record = journal.next(includePrivate = true) ?: return Drain.COMPLETE
            when (val result = transport.send(record.copyPublic())) {
                UploadResult.Accepted -> journal.acknowledge(record.getString("id"))
                is UploadResult.Failed -> {
                    Log.e("PebbleErrors", "Error upload attempt failed", result.error as? Throwable)
                    if (record.optString("_kind") != "upload") journal.add(Capture.internal(
                        record.getString("source"), "uploading an error report", result.error, secrets,
                    ))
                    return if (result.transient) Drain.TRANSIENT else Drain.PERMANENT
                }
            }
        }
        return Drain.TRANSIENT
    }
}
internal class HttpsTransport(private val key: String) : UploadTransport {
    override fun send(record: JSONObject): UploadResult = try {
        val connection = URL("${ErrorReporter.ENDPOINT}/v1/errors").openConnection() as HttpsURLConnection
        connection.requestMethod = "POST"; connection.connectTimeout = 8_000; connection.readTimeout = 12_000
        connection.instanceFollowRedirects = false; connection.doOutput = true
        connection.setRequestProperty("X-Pebble-Diagnostics-Key", key)
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        connection.outputStream.bufferedWriter().use { it.write(JSONObject().put("records", JSONArray().put(record)).toString()) }
        val status = connection.responseCode
        val response = runCatching { (if (status in 200..299) connection.inputStream else connection.errorStream)
            ?.bufferedReader()?.use { it.readText().take(16_384) }.orEmpty() }.getOrDefault("")
        connection.disconnect()
        if (status !in 200..299) UploadResult.Failed(HttpUploadError(status, ErrorReporter.ENDPOINT, response),
            status == 408 || status == 425 || status == 429 || status >= 500)
        else if (JSONObject(response).getJSONArray("accepted").let { accepted ->
                accepted.length() == 1 && accepted.optString(0) == record.getString("id")
            }) UploadResult.Accepted
        else UploadResult.Failed(IllegalStateException("Upload response omitted the submitted ID."), false)
    } catch (error: Throwable) { UploadResult.Failed(error, true) }
}
internal class HttpUploadError(val status: Int, val endpoint: String, val responseBody: String) :
    Exception("Error upload returned HTTP $status from $endpoint")
