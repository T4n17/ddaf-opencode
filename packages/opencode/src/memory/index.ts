import z from "zod"
import path from "path"
import { Effect, Layer, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Config } from "../config/config"
import { AppFileSystem } from "@/filesystem"
import { Global } from "../global"
import { Log } from "../util/log"
import { generateObject, type ModelMessage } from "ai"
import { Provider } from "../provider/provider"
import { Auth } from "../auth"

export namespace Memory {
  const log = Log.create({ service: "memory" })

  export const Store = z.object({
    version: z.literal(2).default(2),
    summary: z.string().default(""),
  })
  export type Store = z.infer<typeof Store>

  // v1 schema for migration
  const V1 = z.object({
    version: z.number(),
    entries: z.array(z.object({ summary: z.string() })),
  })

  const MERGE_PROMPT = `You are a memory summarizer. You receive an existing summary and a new conversation excerpt.
Merge them into a single concise summary (max ~500 words) that preserves all important information.
Drop redundant details. Keep facts, decisions, code written, tools used, and user preferences.
Output only the merged summary text, nothing else.`

  function file() {
    return path.join(Global.Path.data, "memory.json")
  }

  interface State {
    store: Store
    dirty: boolean
  }

  export interface Interface {
    readonly add: (text: string) => Effect.Effect<void>
    readonly get: () => Effect.Effect<string>
    readonly clear: () => Effect.Effect<void>
    readonly flush: () => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Memory") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fsys = yield* AppFileSystem.Service
      const provider = yield* Provider.Service

      const state = yield* InstanceState.make(
        Effect.fn("Memory.state")(function* () {
          const fp = file()
          const exists = yield* fsys.existsSafe(fp)
          if (exists) {
            const raw = yield* fsys.readFileString(fp).pipe(
              Effect.catch(() => Effect.succeed("{}")),
            )
            const json = JSON.parse(raw)
            // migrate v1 → v2
            const v1 = V1.safeParse(json)
            if (v1.success && v1.data.entries?.length) {
              const merged = v1.data.entries.map((e) => e.summary).join("\n")
              log.info("migrated v1", { count: v1.data.entries.length })
              return { store: { version: 2 as const, summary: merged }, dirty: true } as State
            }
            const parsed = Store.safeParse(json)
            if (parsed.success) {
              log.info("loaded", { length: parsed.data.summary.length })
              return { store: parsed.data, dirty: false } as State
            }
          }
          return { store: { version: 2 as const, summary: "" }, dirty: false } as State
        }),
      )

      const flush = Effect.fn("Memory.flush")(function* () {
        const s = yield* InstanceState.get(state)
        if (!s.dirty) return
        const fp = file()
        yield* fsys.ensureDir(path.dirname(fp)).pipe(Effect.catch(Effect.die))
        yield* fsys.writeFileString(fp, JSON.stringify(s.store, null, 2)).pipe(
          Effect.catch(Effect.die),
        )
        s.dirty = false
        log.info("flushed", { length: s.store.summary.length })
      })

      const merge = Effect.fn("Memory.merge")(function* (prev: string, text: string) {
        if (!prev) return text.slice(0, 2000)
        const model = yield* provider.defaultModel()
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const lang = yield* provider.getLanguage(resolved)

        return yield* Effect.tryPromise({
          try: () =>
            generateObject({
              model: lang,
              temperature: 0,
              messages: [
                { role: "system", content: MERGE_PROMPT } satisfies ModelMessage,
                {
                  role: "user",
                  content: `<existing_summary>\n${prev}\n</existing_summary>\n\n<new_conversation>\n${text}\n</new_conversation>`,
                } satisfies ModelMessage,
              ],
              schema: z.object({ summary: z.string() }),
            }).then((r) => r.object.summary),
          catch: (err) => err,
        }).pipe(
          Effect.catch(
            Effect.fnUntraced(function* (err) {
              log.error("merge failed, using concatenation", { err })
              return (prev + "\n" + text).slice(-2000)
            }),
          ),
        )
      })

      const add = Effect.fn("Memory.add")(function* (text: string) {
        const s = yield* InstanceState.get(state)
        s.store.summary = yield* merge(s.store.summary, text)
        s.dirty = true
        log.info("updated", { length: s.store.summary.length })
      })

      const get = Effect.fn("Memory.get")(function* () {
        const s = yield* InstanceState.get(state)
        return s.store.summary
      })

      const clear = Effect.fn("Memory.clear")(function* () {
        const s = yield* InstanceState.get(state)
        s.store.summary = ""
        s.dirty = true
      })

      return Service.of({ add, get, clear, flush })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function add(text: string) {
    return runPromise((svc) => svc.add(text))
  }

  export async function get() {
    return runPromise((svc) => svc.get())
  }

  export async function flush() {
    return runPromise((svc) => svc.flush())
  }
}
