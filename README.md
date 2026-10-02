# dsh-radio-dock 📻

把 [godot_citys](https://github.com/lemonhall) 里那套**车载电台**搬进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**右侧栏**，配一个 three.js 的车内视角：夜里在弯路上一直开，电台放 City Pop。

> 右侧栏本来就是个 apps 入口 —— 官方的「文件 / 终端 / 浏览器」和第三方插件走的是同一套机制。这个插件在里面又加了一个座位。

## 效果

- **车内视角**：驾驶位高度、仪表台与方向盘剪影；月光、星空、月亮（带光晕）
- **会弯的公路**：路面按三个正弦叠加的曲线做顶点位移，96 段；相机横向跟曲线、朝向跟切线
- **车流**：同向的慢车被我们一辆辆超过（红色尾灯），对向的迎面掠过（暖白大灯）；护栏柱、路灯、远处城市剪影循环
- **电台**：频道来自 [radio-browser.info](https://www.radio-browser.info/)，四个标签预设（City Pop / Jazz / Synthwave / Lofi）、频道列表、**8 个快捷槽**、开关 / 上下台 / 音量
- **断流自愈**：公共电台被服务器掐断是常态，客户端有重连 + 看门狗（连"没暂停但播放位置不前进"的僵尸连接也会重连）

## 安装

```
plugin_manager  install_bundle  target=link:E:\development\dsh-radio-dock
```

或者克隆到本地后把路径换成你自己的：

```
git clone https://github.com/lemonhall/dsh-radio-dock
plugin_manager  install_bundle  target=link:<仓库路径>
```

⚠️ **客户端半边（右侧栏那个 tab）改动要重启一次应用**；宿主半边热生效。

装好之后：右侧栏点「+」→ 选 **📻 车载电台**。

## 它是怎么work的

```
lib/index.js    宿主半：三条同源只读/中转路由
                  /dsh-radio/ping       配置自检
                  /dsh-radio/stations   取频道目录（curl 经本机代理 → radio-browser）
                  /dsh-radio/stream     音频流转发（curl 走代理，边收边 pipe）
                  /dsh-radio/three.module.js  把插件自带的 three.js 递出去
lib/client.js   客户端半：注册右侧栏 tab（sidebarRightTabs + 两个 keyed slot）
                  RadioScene = three.js 场景；RadioPanel = 电台 UI
vendor/three.module.js   three r169（已随包，不依赖 CDN）
```

**为什么音频要宿主中转**：① 目录与音频都得走本机代理（`127.0.0.1:7897`）；② 很多公共电台是 `http` 流，而页面是 `http://127.0.0.1:19387` —— 混合内容会被浏览器拦；③ 顺便绕开 CORS。

## 配置

`cordis.patch.yml`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiBase` | `https://de1.api.radio-browser.info` | 电台目录（与原项目 `CityRadioBrowserApi.gd` 一致） |
| `proxy` | `http://127.0.0.1:7897` | 目录与音频流都走它 |
| `defaultCountry` / `defaultTag` | `Japan` / `city pop` | 默认捞哪个方向 |
| `cacheTtlMs` | 21600000（6h） | 目录缓存 |
| `streamTimeoutMs` | 21600000（6h） | 音频流**总时限**（`curl --max-time`）。⚠️ 写小了就是"播一会儿自己停" |

## 源自哪儿

`E:\development\godot_citys` 的 `city_game/world/radio/`（Controller / Catalog / QuickBank / StreamResolver / UserState）、`city_game/ui/CityVehicleRadio*`、`city_game/native/radio_backend/`（带 FFmpeg 的 C++ GDExtension）。

**移植时不需要那个 native 后端** —— 浏览器 `<audio>` 直接放流即可。热键语义也照搬了原项目 `project.godot` 的 `vehicle_radio_power_toggle / next / prev / quick_open / browser_open / confirm / cancel`。

## 已知限制

- 频道靠公共目录 + 公共流，**可用性不保证**（有的台会挂、会限流）
- 没有做"当前播放曲目"（大部分公共流不带 ICY 元数据，拿到也不准）
- 车流是程序生成的，不是真实交通模拟

## License

MIT
