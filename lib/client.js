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

      const camera = new THREE.PerspectiveCamera(62, width / height, 0.1, 900)
      // 我们的车在右车道：相机放在 x = +LANE，中央虚线落在视线左侧才像在开车
      const LANE = 2.0
      camera.position.set(LANE, 1.35, 0)       // 驾驶位高度
      camera.rotation.x = -0.03

      // 路面（两车道，各 4.5 米）
      const road = new THREE.Mesh(
        new THREE.PlaneGeometry(9, 900),
        new THREE.MeshBasicMaterial({ map: roadTexture(THREE) }),
      )
      road.rotation.x = -Math.PI / 2
      road.position.z = -420
      scene.add(road)
      const roadMap = road.material.map

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
        lamps.push({ group, z })
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
        scene.add(post)
        posts.push(post)
      }

      // 车流。世界里相机不动，位移全加在 z 上：
      //   同向慢车 → vz = speed - 6..12（我们从后面超过它，看到尾灯）
      //   对向车   → vz = speed + 12..22（迎面掠过，看到头灯）
      const CAR_COLORS = [0x2b3550, 0x3a2f42, 0x223a3a, 0x40342a, 0x2a2a38]
      const tailMaterial = new THREE.MeshBasicMaterial({ color: 0xff4436 })
      const headMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0c0 })
      const cabinMaterial = new THREE.MeshBasicMaterial({ color: 0x0b0e15 })
      const carLampGeometry = new THREE.SphereGeometry(0.11, 6, 6)
      const bodyGeometry = new THREE.BoxGeometry(1.7, 0.62, 4.1)
      const carCabinGeometry = new THREE.BoxGeometry(1.5, 0.55, 1.9)
      const traffic = []

      function makeCar(oncoming) {
        const group = new THREE.Group()
        const body = new THREE.Mesh(
          bodyGeometry,
          new THREE.MeshBasicMaterial({ color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)] }),
        )
        body.position.y = 0.5
        const cabin = new THREE.Mesh(carCabinGeometry, cabinMaterial)
        cabin.position.set(0, 1.05, oncoming ? 0.25 : -0.25)
        group.add(body, cabin)
        for (const side of [-1, 1]) {
          // 对向车看到的是车头灯，同向车看到的是尾灯
          const lamp = new THREE.Mesh(carLampGeometry, oncoming ? headMaterial : tailMaterial)
          lamp.position.set(side * 0.55, 0.52, oncoming ? -2.06 : 2.06)
          group.add(lamp)
        }
        return group
      }

      function resetCar(entry) {
        entry.group.position.z = -180 - Math.random() * 320
        entry.group.position.x = entry.lane + (Math.random() - 0.5) * 0.5
        // 同向车比我们慢（负数），对向车是正的、加上我们的速度后掠得很快
        entry.extra = entry.oncoming ? 12 + Math.random() * 10 : -(6 + Math.random() * 6)
      }

      for (const oncoming of [false, false, false, true, true, true, true]) {
        const group = makeCar(oncoming)
        const entry = { oncoming, group, lane: oncoming ? -LANE : LANE, extra: 0 }
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
        // 路面滚动
        roadMap.offset.y -= (speed * dt) / 36
        // 路灯循环
        for (const lamp of lamps) {
          lamp.group.position.z += speed * dt
          if (lamp.group.position.z > 6) lamp.group.position.z -= lampCount / 2 * 34
        }
        // 城市循环
        for (const box of city) {
          box.position.z += speed * dt * 0.35
          if (box.position.z > 40) {
            const side = Math.random() < 0.5 ? -1 : 1
            box.position.z = -520 - Math.random() * 120
            box.position.x = side * (30 + Math.random() * 70)
          }
        }
        // 车流：同向的超车、对向的迎面来
        for (const entry of traffic) {
          entry.group.position.z += (speed + entry.extra) * dt
          if (entry.group.position.z > 16) resetCar(entry)
          // 一点点颠簸，别像贴纸一样平移
          entry.group.position.y = Math.sin(now / 220 + entry.group.position.z) * 0.02
        }
        // 护栏柱循环
        for (const post of posts) {
          post.position.z += speed * dt
          if (post.position.z > 8) post.position.z -= POST_PAIRS * POST_GAP
        }
        // 轻微车身晃动：速度越快抖得越明显
        const t = now / 1000
        camera.position.x = Math.sin(t * 1.7) * 0.02 + Math.sin(t * 5.3) * 0.006 * Math.min(1, speed / 30)
        camera.position.y = 1.35 + Math.sin(t * 2.3) * 0.012
        camera.rotation.z = Math.sin(t * 1.1) * 0.004
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

      const play = React.useCallback((station) => {
        const audio = audioRef.current
        if (!audio) return
        setCurrent(station)
        audio.src = `${ROUTES.stream}?u=${encodeURIComponent(station.url)}`
        audio.volume = volume
        audio.play().then(
          () => setPlaying(true),
          () => setPlaying(false),
        )
      }, [volume])

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
        h('audio', { ref: audioRef, onEnded: () => setPlaying(false), preload: 'none' }),

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
