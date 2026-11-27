const TRANSITION_MS = 800
const DWELL_MS = 950
const CONFIRM_FRAME_MS = 80
const READING_GAP_MS = 320
const SENSOR_TIMEOUT_MS = 900
const SENSOR_HZ = 60
const MAX_CURSOR_STEP_PX = 18
const FULL_TURN = Math.PI * 2
const GREEN = '#4cc773'

export const phraseAimSession = { current: null }

export function songChoiceLayout(viewportWidth, viewportHeight) {
  const width = viewportWidth > 0 ? Math.min(448, Math.max(1, Math.floor(viewportWidth) - 32)) : 448
  const height = viewportHeight > 0 ? Math.min(328, Math.max(1, Math.floor(viewportHeight) - 24)) : 328
  const compact = height <= 176 || width < 300
  const cardWidth = Math.min(156, Math.floor(width * 0.39))
  const cardHeight = Math.min(60, Math.floor(height * (compact ? 0.22 : 0.20)))
  const gap = Math.floor(width * 0.036)
  const top = Math.round(height * 0.30)
  const bottom = Math.round(height * 0.61)
  const leftCenter = Math.floor(width / 2)
  const boxes = [
    { x: leftCenter - gap - cardWidth, y: top },
    { x: leftCenter + gap, y: top },
    { x: Math.floor((width - cardWidth) / 2), y: bottom }
  ].map(({ x, y }) => ({
    x, y, width: cardWidth, height: cardHeight,
    style: `left:${x}px;top:${y}px;width:${cardWidth}px;height:${cardHeight}px;`
  }))
  return { width, height, compact, boxes }
}

function normalizedQuaternion(value) {
  if (!value || value.length !== 4 || !Array.from(value).every(Number.isFinite)) return null
  const length = Math.hypot(...value)
  return length > 0 ? Array.from(value, part => part / length) : null
}

// Rotate the screen's forward axis (-Z) by the pose relative to the centered pose.
function relativeAim([a, b, c, d], [x, y, z, w]) {
  const rx = d * x - a * w - b * z + c * y
  const ry = d * y + a * z - b * w - c * x
  const rz = d * z - a * y + b * x - c * w
  const rw = d * w + a * x + b * y + c * z
  const forwardX = -2 * (rx * rz + rw * ry)
  const forwardY = -2 * (ry * rz - rw * rx)
  const forwardZ = -1 + 2 * (rx * rx + ry * ry)
  return [Math.atan2(forwardX, -forwardZ), Math.atan2(forwardY, Math.hypot(forwardX, forwardZ))]
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function drawTunnel(ctx, width, height, progress) {
  const cx = width * (0.50 + Math.sin(progress * Math.PI) * 0.022)
  const cy = height * 0.49
  const opacity = Math.min(1, progress * 9, (1 - progress) * 6)
  const travel = progress + progress * progress * 5
  ctx.lineWidth = 1.2
  let farthest
  let nearest
  for (let index = 0; index < 7; index++) {
    const depth = 0.46 + ((index + 7 - travel) % 7) * 0.37
    const twist = 0.12 * (depth - 1) - progress * 0.34
    const corners = Array.from({ length: 8 }, (_, side) => {
      const angle = (side + 0.5) * FULL_TURN / 8 + twist
      return [cx + Math.cos(angle) * width * 0.32 / depth, cy + Math.sin(angle) * height * 0.37 / depth]
    })
    if (!farthest || depth > farthest.depth) farthest = { depth, corners }
    if (!nearest || depth < nearest.depth) nearest = { depth, corners }
    ctx.strokeStyle = `rgba(76,199,115,${opacity * (0.18 + 0.50 / (1 + depth))})`
    ctx.beginPath()
    ctx.moveTo(...corners[7])
    for (const point of corners) ctx.lineTo(...point)
    ctx.stroke()
  }
  ctx.strokeStyle = `rgba(76,199,115,${opacity * 0.23})`
  ctx.beginPath()
  for (let index = 0; index < 8; index++) {
    ctx.moveTo(...farthest.corners[index])
    ctx.lineTo(...nearest.corners[index])
  }
  ctx.stroke()
  ctx.strokeStyle = `rgba(76,199,115,${opacity * 0.65})`
  ctx.beginPath()
  for (let index = 0; index < 22; index++) {
    const angle = index * 2.39996
    const radius = 0.09 + ((index * 0.373 + progress * (0.3 + progress * 1.22)) % 1) * 0.66
    const dx = Math.cos(angle) * width * radius
    const dy = Math.sin(angle) * height * radius
    ctx.moveTo(cx + dx * 0.89, cy + dy * 0.89)
    ctx.lineTo(cx + dx, cy + dy)
  }
  ctx.stroke()
}

function drawReticle(ctx, x, y, progress) {
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(76,199,115,0.60)'
  ctx.beginPath()
  ctx.arc(x, y, 12, 0, FULL_TURN)
  ctx.stroke()
  ctx.fillStyle = GREEN
  ctx.beginPath()
  ctx.arc(x, y, 2, 0, FULL_TURN)
  ctx.fill()
  if (progress <= 0) return
  ctx.lineWidth = 2.5
  ctx.strokeStyle = GREEN
  ctx.beginPath()
  ctx.arc(x, y, 12, -Math.PI / 2, -Math.PI / 2 + FULL_TURN * progress)
  ctx.stroke()
}

function drawButtonProgress(ctx, box, progress) {
  if (progress <= 0) return
  const halfWidth = Math.min(28, box.width * 0.26) * progress
  const center = box.x + box.width / 2
  const y = box.y + box.height - 4
  ctx.lineWidth = 2
  ctx.strokeStyle = GREEN
  ctx.beginPath()
  ctx.moveTo(center - halfWidth, y)
  ctx.lineTo(center + halfWidth, y)
  ctx.stroke()
}

export class SongChoice {
  constructor(page, layout, createCanvas) {
    this.page = page
    this.layout = layout
    this.createCanvas = createCanvas
    this.focus = -1
    this.latched = -1
    this.aimWidth = layout.width
    this.aimHeight = layout.height
    this.center()
  }

  center() {
    this.x = this.aimWidth / 2
    this.y = this.aimHeight / 2
    this.anchorToCursor()
  }

  anchorToCursor() {
    this.targetX = this.x
    this.targetY = this.y
    this.yaw = (this.x / this.aimWidth - 0.5) * 0.65
    this.pitch = (0.5 - this.y / this.aimHeight) * 0.50
    this.basePose = null
    this.gyroAt = null
    this.lastReadingAt = null
  }

  start({ transition = true } = {}) {
    this.active = true
    this.startedAt = performance.now()
    this.transition = transition
    this.startSensor('absolute')
    this.frame = requestAnimationFrame(() => this.draw())
  }

  bindPage(page, layout, createCanvas) {
    if (this.page === page) return
    this.unbindPage(this.page)
    this.clearIdleTimer()
    this.page = page
    this.layout = layout
    this.createCanvas = createCanvas
    this.startedAt = performance.now()
    this.transition = false
    this.ready = false
    this.firstFrame = true
    this.canvasUnavailable = false
    this.x = clamp(this.x, 13, Math.max(13, layout.width - 13))
    this.y = clamp(this.y, 13, Math.max(13, layout.height - 13))
    this.requireMove()
    if (!this.sensor) {
      const kind = this.fallback ? 'absolute' : this.sensorKind
      this.fallback = false
      this.startSensor(kind)
    }
    this.frame = requestAnimationFrame(() => this.draw())
  }

  unbindPage(page) {
    if (!page || this.page !== page) return
    if (this.frame != null) cancelAnimationFrame(this.frame)
    this.frame = null
    const ctx = this.context
    this.context = null
    if (ctx) {
      try {
        ctx.clearRect(0, 0, this.layout.width, this.layout.height)
        ctx.flush()
      } catch { /* The host may have already removed this canvas. */ }
    }
    this.page = null
    this.createCanvas = null
    this.focus = -1
    this.latched = -1
    if (this.worldPage) {
      this.stopSensor()
      this.anchorToCursor()
    } else if (this.active && this.sensor) {
      // Keep sampling during navigation, and release the sensor if the app stays hidden.
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null
        this.stopSensor()
        this.anchorToCursor()
      }, SENSOR_TIMEOUT_MS)
    }
  }

  clearIdleTimer() {
    if (this.idleTimer != null) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  startSensor(kind) {
    this.sensorKind = kind
    let sensor
    try {
      if (kind === 'absolute') {
        if (typeof AbsoluteOrientationSensor === 'function') {
          sensor = new AbsoluteOrientationSensor({ frequency: SENSOR_HZ })
        }
      } else if (kind === 'page') {
        if (!this.page) return
        if (typeof this.page.enableWorldAwareness === 'function') {
          this.worldPage = this.page
          this.worldPage.enableWorldAwareness()
          sensor = this.worldPage.orientationSensor
        }
      } else if (typeof Gyroscope === 'function') {
        sensor = new Gyroscope({ frequency: SENSOR_HZ })
      }
      if (!sensor) {
        this.sensorFailed(kind)
        return
      }
      this.sensor = sensor
      this.sensorStartedAt = performance.now()
      this.onSensorReading = () => { if (this.sensor === sensor) this.readSensor(sensor, kind) }
      this.onSensorError = () => { if (this.sensor === sensor) this.sensorFailed(kind) }
      sensor.addEventListener('reading', this.onSensorReading)
      sensor.addEventListener('error', this.onSensorError)
      if (!this.worldPage) sensor.start()
    } catch (error) {
      console.warn('方向传感器不可用', error)
      this.sensorFailed(kind)
    }
  }

  sensorFailed(kind) {
    this.stopSensor()
    this.anchorToCursor()
    if (this.page) this.requireMove()
    if (kind === 'absolute') return this.startSensor('page')
    if (kind === 'page') return this.startSensor('gyro')
    this.fallback = true
    if (this.ready) this.page?.showChoiceControls(true)
  }

  stopSensor() {
    const sensor = this.sensor
    this.sensor = null
    try {
      if (sensor) {
        sensor.removeEventListener('reading', this.onSensorReading)
        sensor.removeEventListener('error', this.onSensorError)
      }
      if (this.worldPage) this.worldPage.disableWorldAwareness?.()
      else sensor?.stop()
    } catch (error) {
      console.warn('停止方向传感器失败', error)
    } finally {
      this.worldPage = null
    }
  }

  stop() {
    this.active = false
    this.clearIdleTimer()
    this.unbindPage(this.page)
    this.stopSensor()
  }

  readSensor(sensor, kind) {
    if (!this.active || !sensor.hasReading) return
    const now = performance.now()
    if (kind !== 'gyro') {
      const pose = normalizedQuaternion(sensor.quaternion)
      if (!pose) return
      if (!this.basePose) {
        this.basePose = pose
        this.yawOffset = this.yaw
        this.pitchOffset = this.pitch
      }
      const [yaw, pitch] = relativeAim(this.basePose, pose)
      this.yaw = this.yawOffset + yaw
      this.pitch = this.pitchOffset + pitch
    } else {
      if (![sensor.x, sensor.y, sensor.z].every(Number.isFinite)) return
      const gap = now - (this.gyroAt ?? -Infinity)
      const elapsed = gap <= READING_GAP_MS ? Math.min(gap / 1000, 0.05) : 0
      this.gyroAt = now
      this.yaw = clamp(this.yaw - sensor.y * elapsed, -0.52, 0.52)
      this.pitch = clamp(this.pitch + sensor.x * elapsed, -0.44, 0.44)
    }
    this.lastReadingAt = now
    this.targetX = this.aimWidth * (0.5 + this.yaw / 0.65)
    this.targetY = this.aimHeight * (0.5 - this.pitch / 0.50)
  }

  updateFocus(target, now) {
    if (target === this.focus) return
    this.focus = target
    this.focusSince = now
    this.latched = -1
    this.page.setChoiceFocus(target)
  }

  requireMove() {
    this.blockedAt = [this.x, this.y]
    this.updateFocus(-1, performance.now())
  }

  draw() {
    const page = this.page
    if (!this.active || !page) return
    const now = performance.now()
    const transition = this.transition ? Math.min(1, (now - this.startedAt) / TRANSITION_MS) : 1
    if (!this.ready && transition >= 1) {
      if (this.transition) this.center()
      this.ready = true
      this.readyAt = this.sensorStartedAt = now
      page.showChoiceControls(!!this.fallback)
    }
    if (this.ready && this.sensor && now - (this.lastReadingAt ?? this.sensorStartedAt) > SENSOR_TIMEOUT_MS) {
      this.sensorFailed(this.sensorKind)
    }
    const { width, height, boxes } = this.layout
    if (!this.context) {
      try { this.context = this.createCanvas() } catch { /* 首帧未挂载时等下一帧。 */ }
    }
    const ctx = this.context
    if (this.ready && !this.fallback && !ctx && now - this.readyAt >= SENSOR_TIMEOUT_MS) {
      this.canvasUnavailable = true
      page.showChoiceControls(true)
    }
    if (ctx) ctx.clearRect(0, 0, width, height)
    if (!this.ready) {
      if (ctx) drawTunnel(ctx, width, height, transition)
    } else if (ctx) {
      page.drawAimUnderlay?.(ctx)
    }
    if (this.ready && !this.fallback && ctx) {
      if (!this.firstFrame) {
        const x = clamp(this.targetX, 13, Math.max(13, width - 13))
        const y = clamp(this.targetY, 13, Math.max(13, height - 13))
        this.x += clamp((x - this.x) * 0.33, -MAX_CURSOR_STEP_PX, MAX_CURSOR_STEP_PX)
        this.y += clamp((y - this.y) * 0.33, -MAX_CURSOR_STEP_PX, MAX_CURSOR_STEP_PX)
      }
      this.firstFrame = false
      if (this.blockedAt && Math.hypot(this.x - this.blockedAt[0], this.y - this.blockedAt[1]) > 15) {
        this.blockedAt = null
      }
      const fresh = this.lastReadingAt != null && now - this.lastReadingAt <= READING_GAP_MS
      const { choiceAvailable } = page.data
      const target = fresh && !this.blockedAt ? boxes.findIndex((box, index) => choiceAvailable[index] &&
        this.x >= box.x && this.x < box.x + box.width && this.y >= box.y && this.y < box.y + box.height) : -1
      this.updateFocus(target, now)
      const held = target === -1 ? 0 : now - this.focusSince
      const progress = Math.min(1, held / DWELL_MS)
      if (target !== -1) drawButtonProgress(ctx, boxes[target], progress)
      drawReticle(ctx, this.x, this.y, progress)
      if (target !== -1 && target !== this.latched && held >= DWELL_MS + CONFIRM_FRAME_MS) {
        this.latched = target
        page.confirmChoice(target)
      }
    }
    if (!this.active || this.page !== page) return
    if (ctx) ctx.flush()
    if (!this.ready || (!this.fallback && !this.canvasUnavailable) || (ctx && page.drawAimUnderlay)) {
      this.frame = requestAnimationFrame(() => this.draw())
    }
  }
}
