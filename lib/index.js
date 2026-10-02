/**
 * Host half of dsh-radio-dock —— 只做两件事：取电台目录、转发音频流。
 *
 * 为什么宿主中转而不是客户端直接连：
 *   1. 目录与音频都要走本机代理（原项目 CityRadioBrowserApi.gd 也有 7897 那条路），
 *      浏览器的 fetch/<audio> 不认这套；
 *   2. 很多公共电台是 http 流，而页面是 http://127.0.0.1:19387 —— 混合内容会被拦，
 *      走同源中转就没这个问题；
 *   3. CORS 也不用求人。
 *
 * 目录接口沿用原项目：`https://de1.api.radio-browser.info`
 *   /json/countries
 *   /json/stations/bycountry/<国家>?hidebroken=true&order=votes&reverse=true&limit=N
 *   /json/stations/bytag/<标签>?hidebroken=true&order=votes&reverse=true&limit=N
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件自带的 three.js（vendor/three.module.js），由只读路由递给 tab。 */
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const THREE_FILE = join(PLUGIN_ROOT, 'vendor', 'three.module.js')

const DEFAULTS = {
  curl: 'curl.exe',
  apiBase: 'https://de1.api.radio-browser.info',
  proxy: 'http://127.0.0.1:7897',
  defaultCountry: 'Japan',
  defaultTag: 'city pop',
  timeoutMs: 20000,
  cacheTtlMs: 21600000,
  streamTimeoutMs: 60 * 60 * 1000,
}

/** 路由前缀，客户端同源 fetch 这两条。 */
const ROUTE_STATIONS = '/dsh-radio/stations'
const ROUTE_STREAM = '/dsh-radio/stream'
const ROUTE_PING = '/dsh-radio/ping'
const ROUTE_THREE = '/dsh-radio/three.module.js'

/** 目录缓存：`<url>` → `{ at, payload }`。 */
const cache = new Map()

function localRejection(req) {
  const headers = (req && req.headers) || {}
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return 405
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
  return null
}

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    /* 连接已经断了 */
  }
}

/** curl 取文本；状态码用 `-w '\n%{http_code}'` 从尾巴切出来。 */
function curlText(url, options) {
  const { proxy, curl = 'curl.exe', timeoutMs = 20000 } = options || {}
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-radio-'))
  const args = ['-sS', '-L', '--compressed', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000)))]
  args.push('-w', '\n%{http_code}')
  if (proxy) args.push('-x', String(proxy))
  args.push(url)
  return new Promise((resolve) => {
    execFile(curl, args, { timeout: timeoutMs + 5000, windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      try {
        rmSync(scratch, { recursive: true, force: true })
      } catch {
        /* gone */
      }
      const raw = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '')
      const match = /\n(\d{3})\s*$/.exec(raw)
      resolve({
        status: match ? Number(match[1]) : 0,
        content: match ? raw.slice(0, match.index) : raw,
        error: error ? String(error.message || error) : undefined,
      })
    })
  })
}

/** radio-browser 的字段很多，只留客户端真正要用的。 */
function normalizeStation(raw) {
  if (!raw || typeof raw !== 'object') return null
  const url = String(raw.url_resolved || raw.url || '').trim()
  if (!url) return null
  return {
    id: String(raw.stationuuid || '').trim(),
    name: String(raw.name || '').trim() || '(无名)',
    url,
    favicon: String(raw.favicon || '').trim(),
    homepage: String(raw.homepage || '').trim(),
    tags: String(raw.tags || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8),
    country: String(raw.country || '').trim(),
    countryCode: String(raw.countrycode || '').trim(),
    codec: String(raw.codec || '').trim(),
    bitrate: Number(raw.bitrate) || 0,
    votes: Number(raw.votes) || 0,
  }
}

async function fetchCatalog(opts, query) {
  const country = String(query.get('country') || opts.defaultCountry || '').trim()
  const tag = String(query.get('tag') || '').trim()
  const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 60))
  const base = String(opts.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '')
  const filters = `hidebroken=true&order=votes&reverse=true&limit=${limit}`
  const primary = tag
    ? `${base}/json/stations/bytag/${encodeURIComponent(tag)}?${filters}`
    : `${base}/json/stations/bycountry/${encodeURIComponent(country)}?${filters}`
  const key = `${primary}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < opts.cacheTtlMs) return { stations: hit.payload, cached: true, source: primary }

  let result = await curlText(primary, opts)
  if (result.status < 200 || result.status >= 300 || !result.content.trim().startsWith('[')) {
    // 标签没结果就退回按国家取，别让面板空着
    const fallback = `${base}/json/stations/bycountry/${encodeURIComponent(opts.defaultCountry || 'Japan')}?${filters}`
    result = await curlText(fallback, opts)
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`目录请求失败：HTTP ${result.status} ${String(result.content || result.error).slice(0, 160)}`)
    }
    const stations = JSON.parse(result.content).map(normalizeStation).filter(Boolean)
    cache.set(key, { at: Date.now(), payload: stations })
    return { stations, cached: false, source: fallback }
  }
  const stations = JSON.parse(result.content).map(normalizeStation).filter(Boolean)
  cache.set(key, { at: Date.now(), payload: stations })
  return { stations, cached: false, source: primary }
}

/** 音频流：用 curl 走代理拉，边收边转发；客户端一断就把 curl 杀掉。 */
function proxyStream(opts, targetUrl, req, res) {
  const args = ['-sS', '-L', '--max-time', String(Math.ceil(opts.streamTimeoutMs / 1000))]
  if (opts.proxy) args.push('-x', String(opts.proxy))
  args.push(targetUrl)
  let child
  try {
    child = spawn(opts.curl || 'curl.exe', args, { windowsHide: true })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error.message || error) })
    return
  }
  let started = false
  child.stdout.once('data', () => {
    if (started) return
    started = true
    try {
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'cache-control': 'no-store',
        // 让浏览器别把它当成可缓存的静态资源
        'access-control-allow-origin': '*',
      })
    } catch {
      /* 已经关了 */
    }
  })
  child.stdout.pipe(res)
  child.stderr.on('data', () => {
    /* curl 的进度/错误不往响应里写 */
  })
  child.on('error', (error) => {
    if (!started) sendJson(res, 502, { ok: false, error: String(error.message || error) })
  })
  child.on('close', () => {
    if (!started) sendJson(res, 502, { ok: false, error: '上游没有返回音频数据' })
    try {
      res.end()
    } catch {
      /* gone */
    }
  })
  const stop = () => {
    try {
      child.kill()
    } catch {
      /* already dead */
    }
  }
  req.on('close', stop)
  res.on('close', stop)
}

/** Host plugin body: two same-origin routes for the radio tab. */
function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const opts = { ...DEFAULTS, ...cfg }
  ctx.inject(['webServer'], (scoped) => {
    const disposers = []
    const guard = (handler) => (req, res) => {
      const rejection = localRejection(req)
      if (rejection !== null) {
        try {
          res.statusCode = rejection
          res.end()
        } catch {
          /* closed */
        }
        return
      }
      Promise.resolve(handler(req, res)).catch((error) => {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      })
    }

    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_PING,
        handler: guard((req, res) =>
          sendJson(res, 200, { ok: true, apiBase: opts.apiBase, country: opts.defaultCountry, tag: opts.defaultTag }),
        ),
      }),
    )

    // three.js 本体：客户端用 import('/dsh-radio/three.module.js') 动态加载，
    // 不依赖 CDN，也没有混合内容/CORS 的问题。
    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_THREE,
        handler: guard((req, res) => {
          const bytes = readFileSync(THREE_FILE)
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'public, max-age=86400',
            'content-length': bytes.length,
          })
          res.end(bytes)
        }),
      }),
    )

    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_STATIONS,
        handler: guard(async (req, res) => {
          const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams
          const { stations, cached, source } = await fetchCatalog(opts, query)
          sendJson(res, 200, { ok: true, cached, source, count: stations.length, stations })
        }),
      }),
    )

    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_STREAM,
        handler: guard((req, res) => {
          const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams
          const target = String(query.get('u') || '').trim()
          if (!/^https?:\/\//i.test(target)) {
            sendJson(res, 400, { ok: false, error: 'u 必须是 http(s) 流地址' })
            return
          }
          proxyStream(opts, target, req, res)
        }),
      }),
    )

    ctx.on('dispose', () => {
      for (const off of disposers) {
        try {
          off()
        } catch {
          /* already gone */
        }
      }
    })
  })
}

export { apply, fetchCatalog, normalizeStation, localRejection, ROUTE_PING, ROUTE_STATIONS, ROUTE_STREAM, DEFAULTS }
