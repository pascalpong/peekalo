package com.peekalo.captureguard

import android.app.Activity
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Build
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.Window
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.util.WeakHashMap

// An in-Activity opaque view, never a new Window or hidden Activity. Keeping this
// UID visible avoids using our own cover to force a NOT_VISIBLE recording report.
// The view retains its accessibility restoration data across JS/module reloads.
internal class CaptureCover private constructor(activity: Activity) : FrameLayout(activity) {
  companion object {
    private const val COVER_TAG = "peekalo-native-capture-guard-cover"
    fun forActivity(activity: Activity): CaptureCover {
      val decor = activity.window.decorView as? ViewGroup ?: error("Activity decor unavailable")
      for (i in 0 until decor.childCount) {
        val child = decor.getChildAt(i)
        if (child.tag == COVER_TAG) return child as? CaptureCover ?: error("Capture cover conflict")
      }
      return CaptureCover(activity)
    }
  }

  private val decor = activity.window.decorView as? ViewGroup ?: error("Activity decor unavailable")
  private val touchCallback = when (val previous = activity.window.callback) {
    is CaptureTouchCallback -> previous
    null -> error("Activity callback unavailable")
    else -> CaptureTouchCallback(previous).also { activity.window.callback = it }
  }
  private val hiddenAccessibility = WeakHashMap<View, Int>()
  private val message = TextView(activity)
  private val retry = Button(activity)
  private var observing = false
  var onRetry: (() -> Unit)? = null
  private val beforeDraw = ViewTreeObserver.OnPreDrawListener {
    if (visibility == VISIBLE) keepAboveContent()
    true
  }

  init {
    tag = COVER_TAG
    // Emergency native adapter to @peekalo/design semantic values: this cover
    // must be available before JavaScript/fonts or React content can initialize.
    setBackgroundColor(Color.rgb(8, 10, 9)) // background #080a09
    alpha = 1f
    elevation = 100_000f
    isClickable = true
    isFocusable = true
    isFocusableInTouchMode = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    if (Build.VERSION.SDK_INT >= 28) accessibilityPaneTitle = "Peekalo screen protection"
    val column = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      val padding = (24 * resources.displayMetrics.density).toInt() // space.lg
      setPadding(padding, padding, padding, padding)
    }
    message.apply {
      setTextColor(Color.rgb(241, 242, 237)) // text #f1f2ed
      textSize = 18f // type.section
      gravity = Gravity.CENTER
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    retry.apply {
      text = "Try again"
      isAllCaps = false
      backgroundTintList = ColorStateList.valueOf(Color.rgb(212, 250, 113)) // accent #d4fa71
      setTextColor(Color.rgb(19, 26, 13)) // onAccent #131a0d
      setOnClickListener { onRetry?.invoke() }
    }
    column.addView(message, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    column.addView(retry, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    addView(column, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER))
  }

  fun block(status: CaptureStatus, checking: Boolean) {
    val newlyBlocking = visibility != VISIBLE || parent !== decor
    message.text = when {
      checking -> "Checking screen recording…"
      status == CaptureStatus.RECORDING -> "Stop screen recording to use Peekalo."
      else -> "Screen recording status is unavailable. Try again."
    }
    retry.visibility = if (!checking && status == CaptureStatus.UNAVAILABLE) VISIBLE else GONE
    retry.isEnabled = onRetry != null
    visibility = VISIBLE
    if (!observing) {
      decor.viewTreeObserver.addOnPreDrawListener(beforeDraw)
      observing = true
    }
    keepAboveContent()
    if (newlyBlocking) {
      // Use the real stream's downTime/pointers. RN's cancellation lookup is
      // keyed by downTime; a fabricated event would leave JS without its CANCEL.
      touchCallback.cancelActiveGesture()
    }
    requestFocus()
  }

  private fun keepAboveContent() {
    if (parent !== decor) {
      (parent as? ViewGroup)?.removeView(this)
      decor.addView(this, ViewGroup.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
    // Restore our full opacity even if app content/layout changes after blocking.
    alpha = 1f
    if (decor.getChildAt(decor.childCount - 1) !== this) bringToFront()
    for (i in 0 until decor.childCount) {
      val child = decor.getChildAt(i)
      if (child !== this) {
        if (!hiddenAccessibility.containsKey(child)) hiddenAccessibility[child] = child.importantForAccessibility
        child.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      }
    }
  }

  fun clear() {
    if (observing && decor.viewTreeObserver.isAlive) decor.viewTreeObserver.removeOnPreDrawListener(beforeDraw)
    observing = false
    visibility = GONE
    hiddenAccessibility.forEach { (view, previous) -> view.importantForAccessibility = previous }
    hiddenAccessibility.clear()
  }
}


// The existing Activity callback keeps all normal dispatch/lifecycle behavior.
// The wrapper has no module/cover reference and lives only with this Window.
// CaptureCover reuse (including JS reloads) reuses this wrapper, not another layer.
private class CaptureTouchCallback(
  private val delegate: Window.Callback
) : Window.Callback by delegate {
  private val stream = ActiveTouchStream<MotionEvent>({ MotionEvent.obtain(it) }, { it.recycle() })

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    try {
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> stream.start(event.downTime, event)
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> stream.clear()
        MotionEvent.ACTION_MOVE, MotionEvent.ACTION_POINTER_DOWN -> stream.update(event.downTime, event)
        MotionEvent.ACTION_POINTER_UP -> {
          // Exclude the lifted pointer using public SDK APIs; preserve the
          // actual downTime, source/device and all surviving pointer data.
          val count = event.pointerCount - 1
          if (count <= 0) stream.clear()
          else {
            val properties = Array(count) { MotionEvent.PointerProperties() }
            val coordinates = Array(count) { MotionEvent.PointerCoords() }
            var target = 0
            for (index in 0 until event.pointerCount) {
              if (index == event.actionIndex) continue
              event.getPointerProperties(index, properties[target])
              event.getPointerCoords(index, coordinates[target])
              target++
            }
            val remaining = MotionEvent.obtain(
              event.downTime, event.eventTime, MotionEvent.ACTION_MOVE, count,
              properties, coordinates, event.metaState, event.buttonState,
              event.xPrecision, event.yPrecision, event.deviceId, event.edgeFlags,
              event.source, event.flags
            )
            try { stream.update(event.downTime, remaining) } finally { remaining.recycle() }
          }
        }
      }
    } catch (_: Throwable) {
      stream.clear() // Tracking must never break ordinary Activity input.
    }
    return delegate.dispatchTouchEvent(event)
  }

  fun cancelActiveGesture() {
    val cancel = stream.takeForCancel() ?: return
    try {
      cancel.action = MotionEvent.ACTION_CANCEL
      // Dispatch at the same callback layer that observed DOWN, preserving any
      // outer callback's coordinate transformation and avoiding a duplicate one.
      delegate.dispatchTouchEvent(cancel)
    } finally {
      cancel.recycle()
    }
  }
}
