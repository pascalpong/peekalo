package com.peekalo.captureguard

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.function.Consumer

class PeekaloCaptureGuardModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var started = false
  private var disposed = false
  private var checking = false
  private var activity: Activity? = null
  private var cover: CaptureCover? = null
  private var manager: WindowManager? = null
  private var callback: Consumer<Int>? = null
  private val state = CaptureGuardState(::applyCover) { snapshot ->
    sendEvent("onCaptureStateChanged", snapshot.payload())
  }

  override fun definition() = ModuleDefinition {
    Name("PeekaloCaptureGuard")
    Events("onCaptureStateChanged")

    // JS subscribes before calling start. The returned initial native state is
    // processed on MAIN before this function returns and its promise resolves.
    AsyncFunction("start") {
      started = true
      refresh()
    }.runOnQueue(Queues.MAIN)

    OnCreate { onMain { if (!disposed) prepareUnknown() } }
    OnActivityEntersForeground { onMain {
      if (!disposed) {
        if (started) refresh() else prepareUnknown()
      }
    } }
    OnActivityEntersBackground { onMain { if (!disposed) suspendGuard() } }
    OnActivityDestroys { onMain {
      if (!disposed) {
        suspendGuard()
        cover?.onRetry = null
        cover = null
        activity = null
      }
    } }
    OnDestroy { onMain {
      disposed = true
      started = false
      suspendGuard()
      cover?.onRetry = null
      // Leave the native view opaque if an Activity outlives its JS/module. A
      // replacement module reuses it and may clear it only after a fresh query.
      cover = null
      activity = null
    } }
  }

  private fun onMain(action: () -> Unit) {
    if (Looper.myLooper() === Looper.getMainLooper()) action() else main.post { action() }
  }

  private fun currentActivity(): Activity? = try { appContext.currentActivity } catch (_: Throwable) { null }
  private fun usable(value: Activity?): Boolean = value != null && !value.isFinishing && !value.isDestroyed

  private fun attachCurrentActivity(): Boolean {
    val current = currentActivity()
    if (!usable(current)) return false
    if (activity !== current || cover == null) {
      cover?.onRetry = null
      activity = current
      cover = CaptureCover.forActivity(current!!)
    }
    cover?.onRetry = {
      if (!disposed) {
        started = true
        refresh()
      }
    }
    return true
  }

  private fun applyCover(status: CaptureStatus) {
    val target = cover
    if (target == null || !usable(activity)) {
      // No Activity means no clear result can be returned, even on API <35.
      if (status == CaptureStatus.CLEAR || status == CaptureStatus.UNSUPPORTED) error("Missing Activity")
      return
    }
    if (status == CaptureStatus.CLEAR || status == CaptureStatus.UNSUPPORTED) target.clear()
    else target.block(status, checking)
  }

  private fun prepareUnknown() {
    checking = true
    try {
      // Cover the previous Activity before adopting a replacement, then cover
      // the replacement before publishing even the intermediate unknown state.
      applyCover(CaptureStatus.UNAVAILABLE)
      if (attachCurrentActivity()) applyCover(CaptureStatus.UNAVAILABLE)
    } catch (_: Throwable) { /* Unavailable below; JS must stay blocked. */ }
    state.invalidate()
  }

  private fun suspendGuard() {
    checking = false
    state.invalidate() // Cover and fence callbacks before unregistering.
    unregister()
  }

  private fun unregister(): Boolean {
    val previous = callback ?: return true
    val previousManager = manager ?: return false
    if (Build.VERSION.SDK_INT < 35) return false
    return try {
      previousManager.removeScreenRecordingCallback(previous)
      callback = null
      manager = null
      true
    } catch (_: Throwable) {
      // Retain the failed registration for a later cleanup attempt. Its epoch
      // is already fenced; never register another callback over unknown cleanup.
      false
    }
  }

  private fun refresh(): Map<String, Any?> {
    prepareUnknown()
    val epoch = state.epoch
    if (disposed || !unregister()) return unavailable()
    try {
      if (!attachCurrentActivity()) return unavailable()
      // Cover the newly adopted Activity before touching the callback API.
      applyCover(CaptureStatus.UNAVAILABLE)
      if (Build.VERSION.SDK_INT < 35) {
        checking = false
        state.accept(epoch, CaptureStatus.UNSUPPORTED)
        return state.snapshot.payload()
      }
      val owner = activity ?: return unavailable()
      if (owner.checkSelfPermission(Manifest.permission.DETECT_SCREEN_RECORDING) != PackageManager.PERMISSION_GRANTED) return unavailable()
      val windowManager = owner.windowManager
      val listener = Consumer<Int> { value ->
        // Executor always posts to MAIN, including a vendor's synchronous call.
        if (!disposed && started && epoch == state.epoch) {
          if (currentActivity() !== owner || !usable(owner)) {
            suspendGuard()
          } else {
            checking = false
            state.accept(epoch, statusFromNative(value))
          }
        }
      }
      manager = windowManager
      callback = listener
      val initial = windowManager.addScreenRecordingCallback({ command -> main.post(command) }, listener)
      checking = false
      // Required initial-state handling: no wait for a future callback, no
      // optimistic clear state. Unexpected values are explicitly unavailable.
      state.accept(epoch, statusFromNative(initial))
    } catch (_: Throwable) {
      state.invalidate()
      unregister()
      return unavailable()
    }
    return state.snapshot.payload()
  }

  private fun unavailable(): Map<String, Any?> {
    checking = false
    state.publish(CaptureStatus.UNAVAILABLE)
    return state.snapshot.payload()
  }

  private fun statusFromNative(value: Int): CaptureStatus = when (value) {
    WindowManager.SCREEN_RECORDING_STATE_NOT_VISIBLE -> CaptureStatus.CLEAR
    WindowManager.SCREEN_RECORDING_STATE_VISIBLE -> CaptureStatus.RECORDING
    else -> CaptureStatus.UNAVAILABLE
  }
}
