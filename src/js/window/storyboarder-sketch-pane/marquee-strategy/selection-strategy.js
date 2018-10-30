const paper = require('paper')
const { getFillColor, getFillAlpha } = require('./selectors')

const constrainPoint = (point, rectangle) => {
  // if paper.Point (and not paper.Segment)
  if (point.round) point = point.round()
  point = paper.Point.max(point, rectangle.topLeft)
  point = paper.Point.min(point, rectangle.bottomRight)
  return point
}

module.exports = class SelectionStrategy {
  constructor (context, parent) {
    this.context = context
    this.parent = parent

    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)
    this._onKeyDown = this._onKeyDown.bind(this)
    this._onKeyUp = this._onKeyUp.bind(this)

    this._onWindowBlur = this._onWindowBlur.bind(this)

    this.offscreenCanvas = document.createElement('canvas')
    this.offscreenContext = this.offscreenCanvas.getContext('2d')

    this.paperScope = paper.setup(this.offscreenCanvas)
    this.paperScope.view.setAutoUpdate(false)
    this.paperScope.view.remove()
  }

  startup () {
    this.offscreenCanvas.width = this.context.sketchPane.width
    this.offscreenCanvas.height = this.context.sketchPane.height
    this.layer = this.context.sketchPane.layers.findByName('composite')

    this.state = {
      started: false,
      complete: false,
      selectionPath: null,
      selectionSubPath: null,
      draftPoint: null,
      straightLinePressed: false,
      isPointerDown: false,

      stateName: 'idle' // idle, freeform, line, add, subtract
    }

    document.addEventListener('pointerdown', this._onPointerDown)
    document.addEventListener('pointermove', this._onPointerMove)
    document.addEventListener('pointerup', this._onPointerUp)
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)
    window.addEventListener('blur', this._onWindowBlur)

    this.context.sketchPane.cursor.setEnabled(false)
    this.context.sketchPane.app.view.style.cursor = 'crosshair'

    this.boundingRect = new paper.Rectangle(
      new paper.Point(0, 0),
      new paper.Point(this.context.sketchPane.width, this.context.sketchPane.height)
    )
  }

  shutdown () {
    this.boundingRect = null

    document.removeEventListener('pointerdown', this._onPointerDown)
    document.removeEventListener('pointermove', this._onPointerMove)
    document.removeEventListener('pointerup', this._onPointerUp)
    window.removeEventListener('keydown', this._onKeyDown)
    window.removeEventListener('keyup', this._onKeyUp)
    window.removeEventListener('blur', this._onWindowBlur)

    this.layer.clear()

    this.context.sketchPane.app.view.style.cursor = 'auto'
    this.context.sketchPane.cursor.setEnabled(true)
  }

  _isLineKeyPressed () {
    return this.context.isCommandPressed('drawing:marquee:straight-line')
  }

  _onPointerDown (event) {
    if (event.target.id === 'toolbar-marquee') return

    if (event.target !== this.context.sketchPaneDOMElement) {
      this.cancel()
      return
    }

    if (
      // not freeform/line/add/subtract
      this.state.stateName === 'idle' &&
      // has already drawn a marquee
      this.state.complete &&
      // pointerdown inside the marquee'd path(s)
      this._hit(event))
    {
      // transition to operating on the selection
      this.parent.marqueeTransitionEvent = event
      this._transitionNext()
      return
    }

    // if this is a new path
    if (!this.state.started) {
      this.context.store.dispatch({ type: 'TOOLBAR_MODE_STATUS_SET', payload: 'busy', meta: { scope: 'local' } })

      if (this.state.stateName === 'add') {
        this.state.selectionSubPath = new paper.Path()
        this.state.isPointerDown = true
        this._addPointFromEvent(event)
        this._draw()

      } else if (this.state.stateName === 'subtract') {
        this.state.selectionSubPath = new paper.Path()
        this.state.isPointerDown = true
        this._addPointFromEvent(event)
        this._draw()

      } else {
        // reset
        this.state.selectionPath = new paper.Path()

        // if the line key is pressed
        if (this._isLineKeyPressed()) {
          this.state.stateName = 'line'
        } else {
          this.state.stateName = 'freeform'
        }

        this.state = {
          ...this.state,
          started: true,
          complete: false,
          isPointerDown: true
        }

        this._addPointFromEvent(event)
        this._draw()

        if (this.state.stateName == 'line') {
          this.state.draftPoint = this.context.sketchPane.localizePoint(event)
        } else {
          this.state.draftPoint = null
        }
      }

      this.context.sketchPane.cursor.setEnabled(false)
      this.context.sketchPane.app.view.style.cursor = 'crosshair'
    }
  }

  _onPointerMove (event) {
    if (this.state.stateName === 'add' || this.state.stateName === 'subtract') {
      this.context.sketchPane.app.view.style.cursor = 'crosshair'

      if (this.state.isPointerDown) {
        this._addPointFromEvent(event)
        this._draw()
      }

    } else {
      if (this._hit(event) && !this.state.isPointerDown && this.state.selectionPath) {
        this.context.sketchPane.app.view.style.cursor = '-webkit-grab'
      } else {
        this.context.sketchPane.app.view.style.cursor = 'crosshair'
      }

      if (!this.state.started) return

      if (!this._isLineKeyPressed() && this.state.isPointerDown) {
        this.state.stateName = 'freeform'
      }

      if (this.state.stateName == 'line') {
        this.state.draftPoint = this.context.sketchPane.localizePoint(event)
      } else {
        this.state.draftPoint = null
        this._addPointFromEvent(event)
      }

      this._draw()
    }
  }

  _onPointerUp (event) {
    this.state.isPointerDown = false

    if (this.state.stateName === 'add' || this.state.stateName === 'subtract') {
      this._addPointFromEvent(event)
      this._endDrawnPath()

    } else {
      if (!this.state.started) return

      if (this._isLineKeyPressed()) {
        this.state.stateName = 'line'
      } else {
        this.state.stateName = 'freeform'
      }

      if (this.state.stateName == 'line') {
        this._addPointFromEvent(event)
        this._draw()
      } else {
        this._addPointFromEvent(event)

        this._endDrawnPath()
      }
    }
  }

  _endDrawnPath () {
    // close the active path
    let activePath = this._getActivePath()
    if (activePath.segments.length) {
      activePath.add(
        constrainPoint(
          activePath.segments[0].point.clone(),
          this.boundingRect
        )
      )
    }

    // avoid self-intersections
    activePath = activePath.unite(this.state.selectionPath)
    if (!activePath.children) {
      if (activePath.segments.length) {
        constrainPoint(
          activePath.add(activePath.segments[0].point.clone()),
          this.boundingRect
        )
      }
    }
    activePath.closePath()

    // selectionPath is now the combined path
    this.state.selectionPath = this._getCombinedPath()
    // clear the sub path
    this.state.selectionSubPath = null

    this.state.started = false
    this.state.complete = true
    this.state.draftPoint = null

    this._draw()

    this.parent.marqueePath = this.state.selectionPath.clone()
    this.state.stateName = 'idle'
  }

  _hit (event) {
    if (!this.state.selectionPath) return false

    let point = this.context.sketchPane.localizePoint(event)
    return this._getCombinedPath().contains(point)
  }

  _transitionNext () {
    this.context.store.dispatch({
      type: 'TOOLBAR_MODE_STATUS_SET', payload: 'idle', meta: { scope: 'local' }
    })

    this.parent.setStrategy('operation')
    this.parent.strategy.fromSelection()
  }

  _addPointFromEvent (event) {
    let point = this.context.sketchPane.localizePoint(event)

    this._getActivePath().add(
      constrainPoint(new paper.Point(point.x, point.y), this.boundingRect)
    )
  }

  _getActivePath () {
    return (this.state.stateName === 'add' || this.state.stateName === 'subtract')
      ? this.state.selectionSubPath
      : this.state.selectionPath
  }

  _getCombinedPath () {
    let result
    if (this.state.stateName === 'add') {
      result = this.state.selectionPath.clone().unite(this.state.selectionSubPath, { insert: false })

    } else if (this.state.stateName === 'subtract') {
      result = this.state.selectionPath.clone().subtract(this.state.selectionSubPath, { insert: false })

    } else {
      result = this.state.selectionPath.clone()

    }

    return result
  }

  _onWindowBlur () {
    // this.cancel()
  }

  _onKeyDown (event) {
    // TODO key bindings
    //      will require re-working the keyboard command interpreter for macOS
    //      due to the cmd key bug
    // e.g.: if (this.context.isCommandPressed('drawing:marquee:copy')) {
    //
    // HACK hardcodes key handler
    if (
      // cut
      (event.key === 'x' && (event.metaKey || event.ctrlKey)) ||
      // copy
      (event.key === 'c' && (event.metaKey || event.ctrlKey)) ||
      // paste
      (event.key === 'v' && (event.metaKey || event.ctrlKey))
    ) {
      // allow command through
      return
    } else {
      event.preventDefault()
    }

    if (this.state.complete) {
      if (this.context.isCommandPressed('drawing:marquee:add')) {
        this.state.stateName = 'add'
        // this.context.sketchPane.app.view.style.cursor = 'zoom-in'
      }
      if (this.context.isCommandPressed('drawing:marquee:subtract')) {
        this.state.stateName = 'subtract'
        // this.context.sketchPane.app.view.style.cursor = 'zoom-out'
      }
    }

    if (this.context.isCommandPressed('drawing:marquee:cancel')) {
      this.cancel()
    }

    if (this.context.isCommandPressed('drawing:marquee:erase')) {
      if (this.state.complete && this.parent.marqueePath) {
        let indices = this.context.visibleLayersIndices
        this.context.emit('addToUndoStack', indices)
        this.context.sketchPane.selectedArea.set(this.parent.marqueePath)
        this.context.sketchPane.selectedArea.erase(indices)
        this.context.sketchPane.selectedArea.unset()
        this.context.emit('markDirty', indices)
        this.deselect()
      }
    }

    if (this.context.isCommandPressed('drawing:marquee:fill')) {
      if (this.state.complete && this.parent.marqueePath) {
        // let indices = this.context.visibleLayersIndices
        let indices = [this.parent.findLayerByName('fill').index]
        let state = this.context.store.getState()
        let color = getFillColor(state)
        let alpha = getFillAlpha(state)
        this.context.emit('addToUndoStack', indices)
        this.context.sketchPane.selectedArea.set(this.parent.marqueePath)
        this.context.sketchPane.selectedArea.fill(indices, color, alpha)
        this.context.sketchPane.selectedArea.unset()
        this.context.emit('markDirty', indices)
        this.deselect()
      }
    }
  }

  _onKeyUp (event) {
    event.preventDefault()

    if (this.state.complete) {
      if (this.state.stateName === 'add' && !this.context.isCommandPressed('drawing:marquee:add')) {
        this.state.stateName = 'freeform'
        this.context.sketchPane.app.view.style.cursor = 'crosshair'
      }
      if (this.state.stateName === 'subtract' && !this.context.isCommandPressed('drawing:marquee:subtract')) {
        this.state.stateName = 'freeform'
        this.context.sketchPane.app.view.style.cursor = 'crosshair'
      }
    }

    if (!this._isLineKeyPressed()) {
      if (this.state.started && this.state.stateName == 'line' && !this.state.isPointerDown) {
        this._endDrawnPath()
      }
    }
  }

  cancel () {
    // attempt to gracefully transition back to drawing
    this.context.store.dispatch({
      type: 'TOOLBAR_MODE_STATUS_SET', payload: 'idle', meta: { scope: 'local' }
    })
    this.context.store.dispatch({ type: 'TOOLBAR_MODE_SET', payload: 'drawing', meta: { scope: 'local' } })
  }

  deselect () {
    this.context.store.dispatch({ type: 'TOOLBAR_MODE_STATUS_SET', payload: 'idle', meta: { scope: 'local' } })

    this.layer.clear()

    this.parent.marqueePath = null
    this.state.stateName = 'idle'

    this.state.selectionPath = new paper.Path()
    this.state.selectionSubPath = null

    this.state.started = false
    this.state.complete = false
    this.state.draftPoint = null
    this.state.isPointerDown = false

    this._draw()
  }

  _draw () {
    let ctx = this.offscreenContext

    ctx.clearRect(0, 0, this.context.sketchPane.width, this.context.sketchPane.height)
    ctx.globalAlpha = 1.0

    let pathToDraw = this._getCombinedPath()

    let children = pathToDraw.children || [pathToDraw]

    for (let n = 0; n < children.length; n++) {
      let child = children[n]

      let pointsToDraw = child.segments.map(segment => ({ x: segment.point.x, y: segment.point.y }))

      // draft point added to last child
      if (this.state.draftPoint != null) {
        if (n === children.length - 1) {
          pointsToDraw.push(this.state.draftPoint)
        }
      }

      if (pointsToDraw.length) {
        ctx.save()

        // white
        ctx.lineWidth = 1
        ctx.strokeStyle = '#fff'
        ctx.setLineDash([])
        ctx.moveTo(pointsToDraw[0].x, pointsToDraw[0].y)
        ctx.beginPath()
        for (let i = 0; i < pointsToDraw.length; i++) {
          let point = pointsToDraw[i]
          ctx.lineTo(point.x, point.y)
        }
        ctx.closePath()
        ctx.stroke()

        // purple
        ctx.lineWidth = 1
        ctx.strokeStyle = '#6A4DE7'
        ctx.setLineDash([2, 5])
        ctx.moveTo(pointsToDraw[0].x, pointsToDraw[0].y)
        ctx.beginPath()
        for (let i = 0; i < pointsToDraw.length; i++) {
          let point = pointsToDraw[i]
          ctx.lineTo(point.x, point.y)
        }
        ctx.closePath()
        ctx.stroke()

        ctx.restore()

        // diagnostic circles:
        //
        // for (let j = 0; j < pointsToDraw.length; j++) {
        //   let point = pointsToDraw[j]
        //   ctx.beginPath()
        //   ctx.arc(point.x, point.y, 10, 0, Math.PI * 2)
        //   ctx.fillStyle = '#f00'
        //   ctx.fill()
        // }
      }
    }

    this.layer.replaceTextureFromCanvas(this.offscreenCanvas)
  }
}