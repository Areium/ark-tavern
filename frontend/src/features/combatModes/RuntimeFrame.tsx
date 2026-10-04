import { useEffect, useId, useRef, useState } from 'react'
import { ABI, encodeJson, MAX_ERROR_LENGTH, MAX_INIT_BYTES, requireSnapshot, runtimeDocument } from './runtimeDocument'
import './runtime.css'

export interface RuntimeFrameProps {
  bundle: { abi: 'ark-combat/1'; id: string; name: string; version: string; digest: string; entry: string; resources: Record<string, string> }
  runId: string
  input: Record<string, unknown>
  snapshot: Record<string, unknown> | null
  onSnapshot: (snapshot: Record<string, unknown>) => Promise<void>
  onComplete: (outcome: 'victory' | 'defeat' | 'retreat', snapshot: Record<string, unknown>) => Promise<void>
  onError: (message: string) => void
}

function Run(props: RuntimeFrameProps) {
  const initial = useRef(props)
  const callbacks = useRef(props)
  const reportedError = useRef(false)
  callbacks.current = props
  const container = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [status, setStatus] = useState<'loading' | 'running' | 'complete' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    if (reportedError.current) return
    const config = initial.current
    const frame = document.createElement('iframe')
    let closed = false, ready = false, started = false, completing = false
    let lastHeartbeat = performance.now(), windowStart = lastHeartbeat, messageCount = 0, sequence = 0, queued = 0
    let chain = Promise.resolve()
    let timer: ReturnType<typeof setInterval> | undefined
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
    const stop = () => {
      closed = true
      clearInterval(timer)
      window.removeEventListener('message', receive)
      frame.remove()
    }
    const fail = (reason: unknown) => {
      if (closed) return
      const message = String(reason instanceof Error ? reason.message : reason).slice(0, MAX_ERROR_LENGTH) || '战斗脚本运行失败'
      stop()
      setError(message)
      setStatus('error')
      reportedError.current = true
      callbacks.current.onError(message)
    }
    const send = (type: string, fields: Record<string, unknown> = {}) => {
      const message = { abi: ABI, token, type, ...fields }
      encodeJson(message, type === 'init' ? MAX_INIT_BYTES : undefined)
      frame.contentWindow?.postMessage(message, '*') // Opaque-origin frames require '*'; inbound messages are source/token checked.
    }
    const receive = (event: MessageEvent) => {
      if (closed || event.source !== frame.contentWindow) return
      const now = performance.now()
      if (now - windowStart >= 1000) { windowStart = now; messageCount = 0 }
      if (++messageCount > 60) { fail('战斗脚本消息过于频繁'); return }
      const message = event.data
      if (!message || message.token !== token || message.abi !== ABI) return
      try {
        encodeJson(message)
        const fields: Record<string, string[]> = {
          ready: [], started: [], heartbeat: [], error: ['message'],
          save: ['requestId', 'snapshot'], complete: ['requestId', 'snapshot', 'outcome'],
        }
        if (typeof message.type !== 'string' || !Object.prototype.hasOwnProperty.call(fields, message.type)) throw new Error('未知脚本消息')
        const keys = ['abi', 'token', 'type', ...fields[message.type]]
        if (Object.keys(message).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(message, key))) throw new Error('无效脚本消息')
        switch (message.type) {
          case 'ready':
            if (ready) throw new Error('重复握手')
            ready = true
            send('init', { entry: config.bundle.entry, resources: config.bundle.resources, input: config.input, snapshot: config.snapshot })
            break
          case 'started':
            if (!ready || started) throw new Error('无效启动状态')
            started = true
            lastHeartbeat = now
            setStatus('running')
            break
          case 'heartbeat':
            if (!ready) throw new Error('握手前收到心跳')
            lastHeartbeat = now
            break
          case 'error':
            if (typeof message.message !== 'string' || message.message.length > MAX_ERROR_LENGTH) throw new Error('无效脚本错误')
            throw new Error(message.message || '战斗脚本运行失败')
          default: {
            if (!started || completing) throw new Error('当前状态不允许存档')
            if (message.requestId !== String(sequence + 1)) throw new Error('无效存档序号')
            requireSnapshot(message.snapshot)
            if (message.type === 'complete' && !['victory', 'defeat', 'retreat'].includes(message.outcome)) throw new Error('无效战斗结果')
            if (++queued > 16) throw new Error('存档队列已满')
            sequence++
            if (message.type === 'complete') completing = true
            chain = chain.then(async () => {
              if (closed) return
              try {
                if (message.type === 'save') await callbacks.current.onSnapshot(message.snapshot)
                else await callbacks.current.onComplete(message.outcome, message.snapshot)
                if (closed) return
                send('ack', { requestId: message.requestId, ok: true })
                if (message.type === 'complete') { stop(); setStatus('complete') }
              } catch (reason) {
                if (closed) return
                const text = String(reason instanceof Error ? reason.message : reason).slice(0, MAX_ERROR_LENGTH) || '存档失败'
                try { send('ack', { requestId: message.requestId, ok: false, error: text }) }
                finally { fail(text) }
              } finally { queued-- }
            })
          }
        }
      } catch (reason) { fail(reason) }
    }
    try {
      if (config.bundle.abi !== ABI || typeof config.bundle.entry !== 'string' || !config.bundle.entry || config.bundle.entry.length > MAX_INIT_BYTES || config.bundle.entry.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(config.bundle.entry)) throw new Error('无效战斗脚本包')
      requireSnapshot(config.input)
      if (config.snapshot !== null) requireSnapshot(config.snapshot)
      if (!config.bundle.resources || typeof config.bundle.resources !== 'object' || Array.isArray(config.bundle.resources)) throw new Error('资源映射必须为 JSON 对象')
      encodeJson(config.bundle.resources, MAX_INIT_BYTES)
      if (Object.values(config.bundle.resources).some(value => typeof value !== 'string' || !value.startsWith('data:'))) throw new Error('资源必须为 data URL')
      // Validate the entire init envelope before allocating a browsing context.
      encodeJson({ abi: ABI, token, type: 'init', entry: config.bundle.entry, resources: config.bundle.resources, input: config.input, snapshot: config.snapshot }, MAX_INIT_BYTES)
      frame.title = `${config.bundle.name} · 战斗运行区域`
      frame.className = 'combat-runtime__frame'
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.referrerPolicy = 'no-referrer'
      frame.srcdoc = runtimeDocument(token)
      window.addEventListener('message', receive)
      const startup = performance.now()
      timer = setInterval(() => {
        const now = performance.now()
        if (!started && now - startup >= 10000) fail('战斗脚本启动超时（10 秒）')
        else if (started && now - lastHeartbeat >= 10000) fail('战斗脚本失去响应（10 秒未收到心跳）')
      }, 250)
      container.current?.appendChild(frame)
    } catch (reason) { fail(reason) }
    return stop
  }, [])

  const name = initial.current.bundle.name
  return <section className="combat-runtime" aria-labelledby={titleId}>
    <header className="combat-runtime__header">
      <h2 id={titleId} tabIndex={0}>{name || '战斗脚本'}</h2>
      <span className={`combat-runtime__status combat-runtime__status--${status}`} role="status" aria-live="polite">
        {{ loading: '正在启动…', running: '运行中', complete: '战斗已结束', error: '运行已停止' }[status]}
      </span>
    </header>
    {status === 'loading' && <p className="combat-runtime__notice">正在加载战斗内容，请稍候。</p>}
    {status === 'error' && <p className="combat-runtime__notice combat-runtime__notice--error" role="alert">{error}</p>}
    {status === 'complete' && <p className="combat-runtime__notice">结果已保存，脚本已停止。</p>}
    <div ref={container} className="combat-runtime__container" aria-busy={status === 'loading'} />
  </section>
}

/** Only a new runId starts a new instance. Snapshot/handler changes never reload a run. */
export default function RuntimeFrame(props: RuntimeFrameProps) {
  return <Run key={props.runId} {...props} />
}
