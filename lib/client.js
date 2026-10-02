/**
 * Client half of dsh-radio-dock —— 右侧栏的「车载电台」tab。
 *
 * 结构：
 *   RadioScene —— three.js 的车内第一人称视角：夜里一条无限延伸的公路，
 *                 路灯、远处城市剪影、雾；路面靠纹理偏移滚动产生速度感。
 *   RadioPanel —— 叠在场景上的电台 UI：频道列表、8 个快捷槽、开关/上下台/音量。
 *   两者都只是这个 tab 的内容；音频用 <audio> 播宿主中转的同源流。
 *
 * 对齐原项目（E:\development\godot_citys）的语义：
 *   project.godot 的热键 vehicle_radio_power_toggle / next / prev / quick_open /
 *   browser_open / confirm / cancel；频道来自 radio-browser.info（宿主转发）。
 *
 * 注意：tab 的运行期信息要 `props.useTabInfo()` 拿，不是平铺 props（README:84）。
 */

const TAB_KIND = 'car-radio'
const TAB_ID = 'dsh-radio-dock:car-radio'

const ROUTES = {
  stations: '/dsh-radio/stations',
  stream: '/dsh-radio/stream',
  ping: '/dsh-radio/ping',
  three: '/dsh-radio/three.module.js',
}

const QUICK_SLOTS = 8

window.__ModuleLoader__.load({
  id: 'dsh-radio-dock',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const C = {
      panel: 'var(--dsw-alias-bg-overlay)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    /* ------------------------------------------------------------ three.js */

    /**
     * 公路的形状：绝对里程（米）→ 横向偏移（米）。
     * 三个不同波长的正弦叠加 —— 弯有长有短，不会像蛇一样规律地摆。
     * 相机、路灯、护栏、车流全都按同一个函数摆位，所以世界是自洽的。
     */
    function roadCurveX(meters) {
      return Math.sin(meters * 0.0026) * 16 + Math.sin(meters * 0.0071 + 1.3) * 5.5 + Math.sin(meters * 0.0009) * 9
    }

    /** 该里程处的切线斜率（dx/d里程），用来让车身跟着弯转。 */
    function roadSlope(meters) {
      return (roadCurveX(meters + 6) - roadCurveX(meters - 6)) / 12
    }

    let threePromise = null
    function loadThree() {
      if (!threePromise) threePromise = import(ROUTES.three)
      return threePromise
    }

    /** 程序生成的沥青纹理：中间虚线 + 两侧边线。省一个外部资源。 */
    function roadTexture(THREE) {
      const canvas = document.createElement('canvas')
      canvas.width = 128
      canvas.height = 512
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#14161c'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      // 中央虚线
      ctx.fillStyle = '#e8e2c8'
      for (let y = 0; y < canvas.height; y += 96) ctx.fillRect(canvas.width / 2 - 3, y, 6, 52)
      // 两侧边线
      ctx.fillRect(6, 0, 4, canvas.height)
      ctx.fillRect(canvas.width - 10, 0, 4, canvas.height)
      const texture = new THREE.CanvasTexture(canvas)
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
      texture.repeat.set(1, 24)
      return texture
    }

    /**
     * 搭场景。返回清理函数。
     * speed 用 ref 传进来，这样电台切台/静音之类的 React 状态变化不会重建场景。
     */
    function buildScene(THREE, mount, speedRef) {
      const width = mount.clientWidth || 480
      const height = mount.clientHeight || 640

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
      renderer.setSize(width, height, false)
      renderer.domElement.style.display = 'block'
      mount.appendChild(renderer.domElement)

      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x090c14)
      scene.fog = new THREE.Fog(0x0b1020, 60, 320)

      // 车灯之外的唯一光源：月光。车身材质要它才有明暗面，否则全是剪影。
      scene.add(new THREE.AmbientLight(0x3a4a6a, 1.7))
      const moon = new THREE.DirectionalLight(0xbcd0ff, 1.6)
      moon.position.set(-30, 60, -20)
      scene.add(moon)

      const camera = new THREE.PerspectiveCamera(62, width / height, 0.1, 900)
      // 我们的车在右车道：相机放在 x = +LANE，中央虚线落在视线左侧才像在开车
      const LANE = 2.0
      camera.position.set(LANE, 1.35, 0)       // 驾驶位高度
      camera.rotation.x = -0.03

      // 路面：宽度分 4 段、长度分 96 段 —— 段数就是弯道的分辨率。每帧按绝对里程
      // 把顶点横向推过去，所以路是真的在弯，不是贴图在飘。
      const ROAD_LENGTH = 900
      const roadGeometry = new THREE.PlaneGeometry(9, ROAD_LENGTH, 4, 96)
      const road = new THREE.Mesh(roadGeometry, new THREE.MeshBasicMaterial({ map: roadTexture(THREE) }))
      road.rotation.x = -Math.PI / 2
      road.position.z = 30 - ROAD_LENGTH / 2
      scene.add(road)
      const roadMap = road.material.map
      const roadPositions = roadGeometry.attributes.position
      const roadBaseX = Float32Array.from({ length: roadPositions.count }, (_, index) => roadPositions.getX(index))
      // 已经开过的绝对里程；所有"跟着路弯"的物体都拿它换算自己的横向位置
      let travelled = 0

      // 路肩
      for (const side of [-1, 1]) {
        const shoulder = new THREE.Mesh(
          new THREE.PlaneGeometry(60, 900),
          new THREE.MeshBasicMaterial({ color: 0x0a0c12 }),
        )
        shoulder.rotation.x = -Math.PI / 2
        shoulder.position.set(side * 36, -0.02, -420)
        scene.add(shoulder)
      }

      // 路灯：暖黄小球挂在细杆上，跑到身后就挪回远处
      const lampCount = 18
      const lamps = []
      const bulbGeometry = new THREE.SphereGeometry(0.28, 8, 8)
      const poleGeometry = new THREE.CylinderGeometry(0.06, 0.06, 6, 6)
      for (let i = 0; i < lampCount; i += 1) {
        const side = i % 2 === 0 ? -1 : 1
        const z = -18 - Math.floor(i / 2) * 34
        const group = new THREE.Group()
        const pole = new THREE.Mesh(poleGeometry, new THREE.MeshBasicMaterial({ color: 0x2a2f3d }))
        pole.position.y = 3
        const bulb = new THREE.Mesh(bulbGeometry, new THREE.MeshBasicMaterial({ color: 0xffd9a0 }))
        bulb.position.set(side * 1.4, 6, 0)
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6), new THREE.MeshBasicMaterial({ color: 0x2a2f3d }))
        arm.rotation.z = Math.PI / 2
        arm.position.set(side * 0.7, 6, 0)
        group.add(pole, bulb, arm)
        group.position.set(side * 5.2, 0, z)
        scene.add(group)
        lamps.push({ group, baseX: side * 5.2 })
      }

      // 远处城市剪影：一批方盒子，跑到身后就换到最前面并随机高度
      const cityCount = 26
      const city = []
      for (let i = 0; i < cityCount; i += 1) {
        const height2 = 8 + Math.random() * 34
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(6 + Math.random() * 10, height2, 6 + Math.random() * 10),
          new THREE.MeshBasicMaterial({ color: 0x111726 }),
        )
        const side = i % 2 === 0 ? -1 : 1
        box.position.set(side * (30 + Math.random() * 70), height2 / 2, -60 - Math.random() * 460)
        scene.add(box)
        city.push(box)
      }

      // 夜空：月亮（带光晕）+ 星星。挂在一个跟着相机横移的组里，相对车身就是"无限远"，
      // 不会因为路弯了而左右漂。材质都要 fog:false —— 否则 900 米外早被雾吞干净了。
      const sky = new THREE.Group()
      scene.add(sky)
      const moonCanvas = document.createElement('canvas')
      moonCanvas.width = 128
      moonCanvas.height = 128
      const moonCtx = moonCanvas.getContext('2d')
      const moonGlow = moonCtx.createRadialGradient(64, 64, 6, 64, 64, 64)
      moonGlow.addColorStop(0, 'rgba(255,252,238,1)')
      moonGlow.addColorStop(0.3, 'rgba(255,246,214,0.94)')
      moonGlow.addColorStop(0.42, 'rgba(226,232,255,0.34)')
      moonGlow.addColorStop(1, 'rgba(170,195,255,0)')
      moonCtx.fillStyle = moonGlow
      moonCtx.fillRect(0, 0, 128, 128)
      const moonMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(240, 240),
        new THREE.MeshBasicMaterial({
          map: new THREE.CanvasTexture(moonCanvas),
          transparent: true,
          depthWrite: false,
          fog: false,
          blending: THREE.AdditiveBlending,
        }),
      )
      moonMesh.position.set(-74, 118, -900)
      sky.add(moonMesh)

      const starCount = 280
      const starPositions = new Float32Array(starCount * 3)
      for (let i = 0; i < starCount; i += 1) {
        const angle = Math.random() * Math.PI * 2
        const radius2 = 700 + Math.random() * 520
        starPositions[i * 3] = Math.cos(angle) * radius2 * 0.95
        starPositions[i * 3 + 1] = 30 + Math.random() * 300
        starPositions[i * 3 + 2] = -Math.abs(Math.sin(angle)) * radius2 - 260
      }
      const starGeometry = new THREE.BufferGeometry()
      starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
      sky.add(
        new THREE.Points(
          starGeometry,
          new THREE.PointsMaterial({
            color: 0xdfe6ff,
            size: 2.2,
            sizeAttenuation: false,
            transparent: true,
            opacity: 0.8,
            fog: false,
          }),
        ),
      )

      // 路边护栏柱：一排短柱跑过去，给速度一个参照
      const posts = []
      const postGeometry = new THREE.BoxGeometry(0.16, 0.95, 0.16)
      const postMaterial = new THREE.MeshBasicMaterial({ color: 0x39404f })
      const POST_GAP = 22
      const POST_PAIRS = 14
      for (let i = 0; i < POST_PAIRS * 2; i += 1) {
        const side = i % 2 === 0 ? -1 : 1
        const post = new THREE.Mesh(postGeometry, postMaterial)
        post.position.set(side * 4.9, 0.47, -10 - Math.floor(i / 2) * POST_GAP)
        post.userData.baseX = side * 4.9
        scene.add(post)
        posts.push(post)
      }

      // 车流。世界里相机不动，位移全加在 z 上：
      //   同向慢车 → vz = speed - 6..12（我们从后面超过它，看到尾灯）
      //   对向车   → vz = speed + 12..22（迎面掠过，看到头灯）
      const CAR_KINDS = ['sedan', 'suv', 'van']
      const CAR_PAINTS = [0x2f3a55, 0x53303a, 0x24504c, 0x5a4a2a, 0x2b2b3a, 0x6a6f7d, 0x8a8f9c]
      const carGlassMaterial = new THREE.MeshLambertMaterial({ color: 0x0a1018 })
      const carTireMaterial = new THREE.MeshLambertMaterial({ color: 0x0c0d12 })
      const carRimMaterial = new THREE.MeshLambertMaterial({ color: 0x8d94a4 })
      const carChromeMaterial = new THREE.MeshLambertMaterial({ color: 0x8b93a3 })
      const carHeadLightMaterial = new THREE.MeshBasicMaterial({ color: 0xfff2cc })
      const carTailLightMaterial = new THREE.MeshBasicMaterial({ color: 0xff3a2c })
      const carTireGeometry = (radius) => new THREE.CylinderGeometry(radius, radius, 0.24, 14).rotateZ(Math.PI / 2)
      const carRimGeometry = (radius) => new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, 0.26, 12).rotateZ(Math.PI / 2)
      const traffic = []

      /**
       * 车的侧面轮廓（x = 车长方向，-后 +前；y = 高度），交给 ExtrudeGeometry 挤出宽度。
       * 三种车型各一条线：轿车有引擎盖斜坡和车顶弧，SUV 更高更方，面包车基本一个方盒子。
       */
      function carOutline(THREE, kind) {
        const shape = new THREE.Shape()
        if (kind === 'van') {
          shape.moveTo(-2.35, 0.42)
          shape.lineTo(-2.45, 1.1)
          shape.lineTo(-2.35, 2.15)
          shape.lineTo(1.05, 2.2)
          shape.lineTo(1.85, 1.62)
          shape.lineTo(2.35, 1.2)
          shape.lineTo(2.45, 0.5)
          shape.lineTo(2.35, 0.42)
        } else if (kind === 'suv') {
          shape.moveTo(-2.35, 0.5)
          shape.lineTo(-2.4, 1.25)
          shape.lineTo(-1.95, 1.35)
          shape.lineTo(-1.2, 1.95)
          shape.lineTo(0.55, 2.0)
          shape.lineTo(1.35, 1.5)
          shape.lineTo(2.3, 1.25)
          shape.lineTo(2.45, 0.72)
          shape.lineTo(2.35, 0.5)
        } else {
          shape.moveTo(-2.3, 0.42)
          shape.lineTo(-2.35, 0.85)
          shape.lineTo(-1.85, 0.98)
          shape.lineTo(-1.05, 1.42)
          shape.lineTo(0.5, 1.5)
          shape.lineTo(1.25, 1.12)
          shape.lineTo(2.2, 0.95)
          shape.lineTo(2.4, 0.6)
          shape.lineTo(2.3, 0.42)
        }
        shape.closePath()
        return shape
      }

      function makeCar(kind, paint, oncoming) {
        const group = new THREE.Group()
        const spec =
          {
            sedan: { width: 1.78, wheel: 0.33, wheelZ: 1.32, wheelX: 0.83, glassZ: 0.5, glassY: 1.22, nose: 2.42 },
            suv: { width: 1.92, wheel: 0.4, wheelZ: 1.45, wheelX: 0.92, glassZ: 0.4, glassY: 1.62, nose: 2.46 },
            van: { width: 1.95, wheel: 0.37, wheelZ: 1.6, wheelX: 0.9, glassZ: 0, glassY: 1.72, nose: 2.44 },
          }[kind] || {}

        // 车身：侧面轮廓挤出，再转 90° 让车长沿 Z 轴
        const bodyGeometry = new THREE.ExtrudeGeometry(carOutline(THREE, kind), { depth: spec.width, bevelEnabled: false })
        bodyGeometry.translate(0, 0, -spec.width / 2)
        bodyGeometry.rotateY(Math.PI / 2)
        group.add(new THREE.Mesh(bodyGeometry, new THREE.MeshLambertMaterial({ color: paint })))

        // 车窗：一条深色玻璃带（前后风挡 + 侧窗），略窄于车身
        const glass = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.88, 0.48, 1.75), carGlassMaterial)
        glass.position.set(0, spec.glassY, spec.glassZ)
        group.add(glass)

        // 轮子：四个圆柱 + 轮毂
        for (const x of [-spec.wheelX, spec.wheelX]) {
          for (const z of [-spec.wheelZ, spec.wheelZ]) {
            const tire = new THREE.Mesh(carTireGeometry(spec.wheel), carTireMaterial)
            tire.position.set(x, spec.wheel, z)
            const rim = new THREE.Mesh(carRimGeometry(spec.wheel), carRimMaterial)
            rim.position.set(x, spec.wheel, z)
            group.add(tire, rim)
          }
        }

        // 前后保险杠
        for (const z of [-spec.nose, spec.nose]) {
          const bumper = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.94, 0.22, 0.16), carChromeMaterial)
          bumper.position.set(0, kind === 'van' ? 0.52 : 0.46, z)
          group.add(bumper)
        }

        // 后视镜
        for (const x of [-1, 1]) {
          const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.12, 0.1), carGlassMaterial)
          mirror.position.set(x * (spec.width / 2 + 0.07), spec.glassY - 0.06, spec.glassZ + 0.95)
          group.add(mirror)
        }

        // 车灯：前面两颗大灯、后面两颗尾灯（对向车我们看到的是它的大灯）
        const lampGeometry = new THREE.BoxGeometry(0.34, 0.15, 0.1)
        for (const x of [-1, 1]) {
          const head = new THREE.Mesh(lampGeometry, carHeadLightMaterial)
          head.position.set(x * (spec.width / 2 - 0.3), kind === 'van' ? 1.05 : 0.92, spec.nose + 0.02)
          const tail = new THREE.Mesh(lampGeometry, carTailLightMaterial)
          tail.position.set(x * (spec.width / 2 - 0.28), kind === 'van' ? 1.18 : 0.96, -spec.nose - 0.02)
          group.add(head, tail)
        }

        // 对向车整辆车转 180°，这样它的车头（大灯）朝着我们
        if (oncoming) group.rotation.y = Math.PI
        return group
      }

      function resetCar(entry) {
        entry.group.position.z = -170 - Math.random() * 340
        entry.offset = (Math.random() - 0.5) * 0.4
        entry.group.position.x = entry.lane + entry.offset
        // 同向车比我们慢（负数），对向车是正的、加上我们的速度后掠得很快
        entry.extra = entry.oncoming ? 12 + Math.random() * 10 : -(6 + Math.random() * 7)
      }

      for (const oncoming of [false, false, false, false, true, true, true, true]) {
        const paint = CAR_PAINTS[Math.floor(Math.random() * CAR_PAINTS.length)]
        const kind = CAR_KINDS[Math.floor(Math.random() * CAR_KINDS.length)]
        const group = makeCar(kind, paint, oncoming)
        const entry = { oncoming, group, lane: oncoming ? -LANE : LANE, extra: 0, offset: 0 }
        scene.add(group)
        resetCar(entry)
        traffic.push(entry)
      }

      // 自己的头灯光斑：贴在地上的一片渐变，落在车头前方
      const beamCanvas = document.createElement('canvas')
      beamCanvas.width = 64
      beamCanvas.height = 128
      const beamCtx = beamCanvas.getContext('2d')
      const beamGradient = beamCtx.createLinearGradient(0, 0, 0, 128)
      beamGradient.addColorStop(0, 'rgba(255,240,200,0.32)')
      beamGradient.addColorStop(1, 'rgba(255,240,200,0)')
      beamCtx.fillStyle = beamGradient
      beamCtx.beginPath()
      beamCtx.moveTo(24, 0)
      beamCtx.lineTo(40, 0)
      beamCtx.lineTo(64, 128)
      beamCtx.lineTo(0, 128)
      beamCtx.closePath()
      beamCtx.fill()
      const beam = new THREE.Mesh(
        new THREE.PlaneGeometry(9, 46),
        new THREE.MeshBasicMaterial({
          map: new THREE.CanvasTexture(beamCanvas),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      )
      beam.rotation.x = -Math.PI / 2
      beam.position.set(LANE, 0.02, -22)
      scene.add(beam)

      let raf = 0
      let last = performance.now()
      const onResize = () => {
        const w = mount.clientWidth || width
        const h2 = mount.clientHeight || height
        renderer.setSize(w, h2, false)
        camera.aspect = w / h2
        camera.updateProjectionMatrix()
      }
      const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
      if (observer) observer.observe(mount)

      function tick(now) {
        const dt = Math.min(0.05, (now - last) / 1000)
        last = now
        const speed = Math.max(0, Number(speedRef && speedRef.current) || 0) // 米/秒
        travelled += speed * dt

        // 路面顶点按绝对里程弯过去 —— 这一段就是"路会弯"的来源
        for (let i = 0; i < roadPositions.count; i += 1) {
          const worldZ = road.position.z - roadPositions.getY(i)
          roadPositions.setX(i, roadBaseX[i] + roadCurveX(travelled - worldZ))
        }
        roadPositions.needsUpdate = true
        roadMap.offset.y -= (speed * dt) / 36

        // 路灯：往前挪，再贴回曲线的横向位置
        for (const lamp of lamps) {
          lamp.group.position.z += speed * dt
          if (lamp.group.position.z > 6) lamp.group.position.z -= (lampCount / 2) * 34
          lamp.group.position.x = lamp.baseX + roadCurveX(travelled - lamp.group.position.z)
        }
        // 城市剪影：只做远景，不跟着弯细调
        for (const box of city) {
          box.position.z += speed * dt * 0.35
          if (box.position.z > 40) {
            const side = Math.random() < 0.5 ? -1 : 1
            box.position.z = -520 - Math.random() * 120
            box.position.x = side * (30 + Math.random() * 70)
          }
        }
        // 车流：同向被我们超、对向迎面来；横向跟着路弯，车头跟着切线
        for (const entry of traffic) {
          entry.group.position.z += (speed + entry.extra) * dt
          if (entry.group.position.z > 16) resetCar(entry)
          const abs = travelled - entry.group.position.z
          entry.group.position.x = entry.lane + (entry.offset || 0) + roadCurveX(abs)
          entry.group.position.y = Math.sin(now / 220 + entry.group.position.z) * 0.02
          entry.group.rotation.y = (entry.oncoming ? Math.PI : 0) - Math.atan(roadSlope(abs))
        }
        // 护栏柱循环
        for (const post of posts) {
          post.position.z += speed * dt
          if (post.position.z > 8) post.position.z -= POST_PAIRS * POST_GAP
          post.position.x = post.userData.baseX + roadCurveX(travelled - post.position.z)
        }
        // 相机：横向跟着曲线走，朝向跟着切线，再加一点车身晃动
        const t = now / 1000
        camera.position.x =
          roadCurveX(travelled) + Math.sin(t * 1.7) * 0.02 + Math.sin(t * 5.3) * 0.006 * Math.min(1, speed / 30)
        camera.position.y = 1.35 + Math.sin(t * 2.3) * 0.012
        camera.rotation.y = -Math.atan(roadSlope(travelled))
        camera.rotation.z = Math.sin(t * 1.1) * 0.004
        beam.position.x = camera.position.x
        sky.position.x = camera.position.x
        renderer.render(scene, camera)
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)

      return () => {
        cancelAnimationFrame(raf)
        if (observer) observer.disconnect()
        renderer.dispose()
        road.geometry.dispose()
        road.material.map.dispose()
        road.material.dispose()
        if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
      }
    }

    function RadioScene(props) {
      const mountRef = React.useRef(null)
      const [failed, setFailed] = React.useState(null)
      React.useEffect(() => {
        let disposed = false
        let cleanup = null
        loadThree()
          .then((THREE) => {
            if (disposed || !mountRef.current) return
            cleanup = buildScene(THREE, mountRef.current, props.speedRef)
          })
          .catch((error) => setFailed(String((error && error.message) || error)))
        return () => {
          disposed = true
          if (cleanup) cleanup()
        }
      }, [])
      return h(
        'div',
        { ref: mountRef, style: { position: 'absolute', inset: 0, overflow: 'hidden' } },
        // three 挂了也要能听电台：给一层纯 CSS 的夜路兜底
        failed
          ? h('div', {
              style: {
                position: 'absolute',
                inset: 0,
                background: 'linear-gradient(180deg,#0a0d16 0%,#121a2b 55%,#1b2334 100%)',
              },
            })
          : null,
      )
    }

    /* -------------------------------------------------------------- 电台 UI */

    /** 仪表台剪影 + 方向盘，纯 CSS/SVG，压在场景下缘，制造"在车里"的框。 */
    function Dashboard() {
      return h(
        'div',
        { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 118, pointerEvents: 'none' } },
        h('div', {
          style: {
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg, rgba(6,8,14,0) 0%, rgba(6,8,14,0.92) 46%, #05070c 100%)',
          },
        }),
        h(
          'svg',
          { viewBox: '0 0 200 90', preserveAspectRatio: 'none', style: { position: 'absolute', inset: 0, width: '100%', height: '100%' } },
          h('ellipse', { cx: 100, cy: 96, rx: 62, ry: 40, fill: 'none', stroke: '#0c1018', strokeWidth: 7 }),
          h('rect', { x: 0, y: 78, width: 200, height: 12, fill: '#05070c' }),
        ),
      )
    }

    function QuickSlots(props) {
      const { slots, activeId, onPick } = props
      return h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: `repeat(${QUICK_SLOTS}, 1fr)`, gap: 4 } },
        slots.map((slot, index) =>
          h(
            'button',
            {
              key: index,
              type: 'button',
              onClick: () => (slot ? onPick(slot) : props.onCapture(index)),
              title: slot ? `${slot.name}` : `把当前电台存到 ${index + 1}`,
              style: {
                padding: '4px 0',
                fontSize: 11,
                fontFamily: C.mono,
                borderRadius: 6,
                border: `1px solid ${slot && slot.id === activeId ? C.brand : C.border}`,
                background: slot ? 'rgba(255,255,255,0.04)' : 'transparent',
                color: slot ? C.text : C.dim,
                cursor: 'pointer',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
              },
            },
            slot ? String(index + 1) : '·',
          ),
        ),
      )
    }

    function StationRow(props) {
      const { station, active, onPick } = props
      return h(
        'button',
        {
          type: 'button',
          onClick: () => onPick(station),
          style: {
            display: 'grid',
            gap: 2,
            textAlign: 'left',
            padding: '6px 8px',
            borderRadius: 8,
            border: `1px solid ${active ? C.brand : 'transparent'}`,
            background: active ? 'rgba(90,130,255,0.12)' : 'transparent',
            color: C.text,
            cursor: 'pointer',
            width: '100%',
          },
        },
        h('span', { style: { fontSize: 13, fontWeight: active ? 600 : 400 } }, station.name),
        h(
          'span',
          { style: { fontSize: 11, color: C.dim, fontFamily: C.mono } },
          [station.countryCode || station.country, station.codec, station.bitrate ? `${station.bitrate}k` : '', ...(station.tags || []).slice(0, 3)]
            .filter(Boolean)
            .join(' · '),
        ),
      )
    }

    function RadioPanel() {
      const info = (() => {
        try {
          return null
        } catch {
          return null
        }
      })()
      void info

      const [stations, setStations] = React.useState([])
      const [listError, setListError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [current, setCurrent] = React.useState(null)
      const [playing, setPlaying] = React.useState(false)
      const [volume, setVolume] = React.useState(0.7)
      const [slots, setSlots] = React.useState(() => new Array(QUICK_SLOTS).fill(null))
      const [browsing, setBrowsing] = React.useState(true)
      const [tag, setTag] = React.useState('city pop')
      const audioRef = React.useRef(null)
      const speedRef = React.useRef(18) // 场景速度，米/秒

      const load = React.useCallback(
        async (nextTag) => {
          setLoading(true)
          setListError(null)
          try {
            const query = new URLSearchParams()
            if (nextTag) query.set('tag', nextTag)
            query.set('limit', '60')
            const response = await fetch(`${ROUTES.stations}?${query.toString()}`)
            const payload = await response.json()
            if (!payload.ok) throw new Error(payload.error || '取目录失败')
            setStations(payload.stations || [])
            return payload.stations || []
          } catch (error) {
            setListError(String((error && error.message) || error))
            return []
          } finally {
            setLoading(false)
          }
        },
        [],
      )

      React.useEffect(() => {
        load('city pop')
      }, [load])

      /** 每次都带防缓存参数：否则浏览器可能复用已经死掉的那条连接。 */
      const streamUrl = React.useCallback(
        (station) => `${ROUTES.stream}?u=${encodeURIComponent(station.url)}&t=${Date.now()}`,
        [],
      )

      const currentRef = React.useRef(null)
      React.useEffect(() => {
        currentRef.current = current
      }, [current])

      const play = React.useCallback(
        (station) => {
          const audio = audioRef.current
          if (!audio) return
          setCurrent(station)
          currentRef.current = station
          audio.src = streamUrl(station)
          audio.volume = volume
          audio.play().then(
            () => setPlaying(true),
            () => setPlaying(false),
          )
        },
        [volume, streamUrl],
      )

      /**
       * 公共电台流被服务器掐断是常态（几分钟一次），<audio> 要么 ended、要么静默
       * stalled。只要还处在"应该在播"的状态就自己接回去；3 秒内不重复重连，
       * 免得服务器一直拒的时候打成死循环。
       */
      const lastReconnectRef = React.useRef(0)
      const reconnect = React.useCallback(() => {
        const station = currentRef.current
        const audio = audioRef.current
        if (!station || !audio) return
        const now = Date.now()
        if (now - lastReconnectRef.current < 3000) return
        lastReconnectRef.current = now
        audio.src = `${streamUrl(station)}&r=${now}`
        audio.play().then(
          () => setPlaying(true),
          () => setPlaying(false),
        )
      }, [streamUrl])

      // 看门狗：期望在播却已经 paused/ended（且不是用户按的暂停），就重连
      React.useEffect(() => {
        if (!playing || !current) return undefined
        const timer = setInterval(() => {
          const audio = audioRef.current
          if (audio && (audio.paused || audio.ended)) reconnect()
        }, 5000)
        return () => clearInterval(timer)
      }, [playing, current, reconnect])

      const togglePower = React.useCallback(() => {
        const audio = audioRef.current
        if (!audio || !current) return
        if (audio.paused) {
          audio.play().then(() => setPlaying(true), () => setPlaying(false))
        } else {
          audio.pause()
          setPlaying(false)
        }
      }, [current])

      const step = React.useCallback(
        (delta) => {
          if (!stations.length) return
          const index = stations.findIndex((station) => current && station.id === current.id)
          const next = stations[(index + delta + stations.length) % stations.length]
          if (next) play(next)
        },
        [stations, current, play],
      )

      React.useEffect(() => {
        const audio = audioRef.current
        if (audio) audio.volume = volume
      }, [volume])

      const capture = (index) => {
        if (!current) return
        setSlots((previous) => {
          const next = previous.slice()
          next[index] = current
          return next
        })
      }

      return h(
        'div',
        { style: { position: 'absolute', inset: 0 } },
        h(RadioScene, { speedRef }),
        h(Dashboard),
        h('audio', {
          ref: audioRef,
          preload: 'none',
          onEnded: () => {
            if (currentRef.current) reconnect()
          },
          onError: () => {
            if (currentRef.current) reconnect()
          },
          onStalled: () => {
            if (currentRef.current) reconnect()
          },
        }),

        // 顶部：当前电台 + 电源
        h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              padding: '10px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'linear-gradient(180deg, rgba(4,6,12,0.88) 0%, rgba(4,6,12,0) 100%)',
              color: C.text,
            },
          },
          h(
            'div',
            { style: { display: 'grid', gap: 2, minWidth: 0, flex: 1 } },
            h('span', { style: { fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              current ? current.name : '车载电台 · 待机'),
            h('span', { style: { fontSize: 11, color: C.dim, fontFamily: C.mono } },
              current
                ? `${current.countryCode || current.country} · ${current.codec} ${current.bitrate}k`
                : `${tag} · ${stations.length} 个频道`),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: togglePower,
              title: playing ? '关掉' : '打开',
              style: {
                width: 34,
                height: 34,
                borderRadius: 999,
                border: `1px solid ${playing ? C.ok : C.border}`,
                background: playing ? 'rgba(70,200,140,0.16)' : 'rgba(255,255,255,0.04)',
                color: playing ? C.ok : C.dim,
                cursor: 'pointer',
                fontSize: 14,
              },
            },
            playing ? '❚❚' : '▶',
          ),
        ),

        // 频道列表
        browsing
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  left: 10,
                  right: 10,
                  top: 62,
                  bottom: 150,
                  background: C.panel,
                  border: `1px solid ${C.border}`,
                  borderRadius: 12,
                  padding: 8,
                  display: 'grid',
                  gridTemplateRows: 'auto 1fr',
                  gap: 6,
                  overflow: 'hidden',
                },
              },
              h(
                'div',
                { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                ...[
                  ['city pop', 'City Pop'],
                  ['jazz', 'Jazz'],
                  ['synthwave', 'Synthwave'],
                  ['lofi', 'Lofi'],
                ].map(([value, label]) =>
                  h(
                    'button',
                    {
                      key: value,
                      type: 'button',
                      onClick: () => {
                        setTag(value)
                        load(value)
                      },
                      style: {
                        padding: '3px 8px',
                        fontSize: 11,
                        borderRadius: 999,
                        border: `1px solid ${tag === value ? C.brand : C.border}`,
                        background: tag === value ? 'rgba(90,130,255,0.16)' : 'transparent',
                        color: tag === value ? C.text : C.dim,
                        cursor: 'pointer',
                      },
                    },
                    label,
                  ),
                ),
                h('span', { style: { marginLeft: 'auto', fontSize: 11, color: C.dim } }, loading ? '加载中…' : `${stations.length}`),
              ),
              h(
                'div',
                { style: { overflow: 'auto', display: 'grid', gap: 2, alignContent: 'start' } },
                listError
                  ? h('div', { style: { fontSize: 12, color: C.err, padding: 8 } }, listError)
                  : stations.map((station) =>
                      h(StationRow, {
                        key: station.id || station.url,
                        station,
                        active: current && station.id === current.id,
                        onPick: play,
                      }),
                    ),
              ),
            )
          : null,

        // 底部：快捷槽 + 切台 + 音量
        h(
          'div',
          {
            style: {
              position: 'absolute',
              left: 10,
              right: 10,
              bottom: 84,
              display: 'grid',
              gap: 8,
              color: C.text,
            },
          },
          h(QuickSlots, { slots, activeId: current && current.id, onPick: play, onCapture: capture }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h(
              'button',
              { type: 'button', onClick: () => step(-1), style: buttonStyle(), title: '上一台' },
              '⏮',
            ),
            h(
              'button',
              { type: 'button', onClick: () => setBrowsing((value) => !value), style: { ...buttonStyle(), flex: 1 }, title: '频道列表' },
              browsing ? '收起列表' : '浏览频道',
            ),
            h(
              'button',
              { type: 'button', onClick: () => step(1), style: buttonStyle(), title: '下一台' },
              '⏭',
            ),
            h('input', {
              type: 'range',
              min: 0,
              max: 1,
              step: 0.01,
              value: volume,
              onChange: (event) => setVolume(Number(event.target.value)),
              style: { width: 74, accentColor: 'var(--dsw-alias-brand-primary)' },
              title: '音量',
            }),
          ),
        ),
      )
    }

    function buttonStyle() {
      return {
        padding: '6px 10px',
        fontSize: 12,
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        background: 'rgba(255,255,255,0.05)',
        color: C.text,
        cursor: 'pointer',
      }
    }

    /* --------------------------------------------------------------- 注册 */

    function tabInfoOf(props) {
      try {
        if (props && typeof props.useTabInfo === 'function') return props.useTabInfo()
      } catch {
        /* tab 还没 committed */
      }
      return null
    }

    function RadioBody() {
      return h(RadioPanel)
    }

    function RadioTitle() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { 'aria-hidden': 'true' }, '📻'),
        h('span', null, '车载电台'),
      )
    }

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      ctx.inject(['sidebarRightTabs'], (scoped) => {
        scoped.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => '车载电台',
          guide: [
            {
              id: TAB_KIND,
              kind: TAB_KIND,
              order: 50,
              title: () => '车载电台',
              description: () => '夜路、City Pop、8 个快捷槽',
              icon: () => h('span', { style: { fontSize: 16 } }, '📻'),
            },
          ],
        })
      })
      ctx.inject(['slots'], (scoped) => {
        scoped.slots.inject('sidebar.right.pane.tab', () =>
          scoped.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, RadioBody),
        )
        scoped.slots.inject('sidebar.right.pane.tab.title', () =>
          scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, RadioTitle),
        )
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
