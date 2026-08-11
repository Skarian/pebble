package com.skarian.airquality

import io.rebble.pebblekit2.common.model.PebbleDictionary
import kotlinx.coroutines.CancellationException

internal data class AirQualityRequest(
    val requestId: Int,
    val command: Int,
    val scale: ChartScale,
    val watchId: String,
)

internal data class AirQualityResponse(
    val operation: String,
    val data: PebbleDictionary,
    val domainCategory: String = "",
)

/** Cached-first Air Quality policy, independent of AppMessage admission and delivery retry. */
internal class AirQualityRequestPipeline(
    private val cachedResponse: suspend (AirQualityRequest) -> AirQualityResponse?,
    private val liveResponse: suspend (AirQualityRequest) -> AirQualityResponse,
    private val liveFailureResponse: suspend (AirQualityRequest) -> AirQualityResponse,
    private val deliver: suspend (AirQualityRequest, AirQualityResponse) -> Unit,
    private val deliverReplay: suspend (AirQualityRequest, List<AirQualityResponse>) -> Unit,
    private val scheduleHistoryRepair: (AirQualityRequest) -> Unit,
    private val reportError: (Throwable) -> Unit = {},
) {
    suspend fun execute(request: AirQualityRequest): List<AirQualityResponse> {
        val cached = cachedResponse(request)
        var replayResponses = cached?.let(::listOf).orEmpty()
        cached?.let { deliver(request, it) }

        if (request.command == PebbleProtocol.COMMAND_FETCH &&
            (cached == null || cached.domainCategory.isBlank())
        ) {
            val live = try {
                liveResponse(request)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                reportError(error)
                liveFailureResponse(request)
            }
            deliver(request, live)
            replayResponses = when {
                live.domainCategory.isBlank() -> listOf(live)
                cached != null && cached.domainCategory.isBlank() -> listOf(cached, live)
                else -> listOf(live)
            }
        }

        scheduleHistoryRepair(request)
        check(replayResponses.size <= 2)
        return replayResponses
    }

    suspend fun replay(request: AirQualityRequest, responses: List<AirQualityResponse>) {
        deliverReplay(
            request,
            responses.map { it.copy(operation = "${it.operation}_replay") },
        )
    }
}
