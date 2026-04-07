import z from "zod"
import { Effect, Layer, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Config } from "../config/config"
import { ConfigMarkdown } from "../config/markdown"
import { Bus } from "@/bus"
import { Glob } from "../util/glob"
import { Log } from "../util/log"

export namespace Domain {
  const log = Log.create({ service: "domain" })

  const DOMAIN_PATTERN = "{domain,domains}/**/*.md"

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    prompt: z.string().optional(),
    tools: z.array(z.string()).optional(),
    mcps: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    permission: z.record(z.string(), z.any()).optional(),
  })
  export type Info = z.infer<typeof Info>

  export const FALLBACK: Info = {
    name: "general",
    description: "General-purpose domain for queries that do not match any specific domain",
    prompt: "You are an AI coding assistant. Help the user with their request. Be concise and direct.",
    tools: [],
  }

  type State = {
    domains: Record<string, Info>
  }

  export interface Interface {
    readonly get: (name: string) => Effect.Effect<Info | undefined>
    readonly all: () => Effect.Effect<Info[]>
    readonly names: () => Effect.Effect<string[]>
    readonly fallback: () => Effect.Effect<Info>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Domain") {}

  const load = Effect.fnUntraced(function* (
    state: State,
    match: string,
    bus: Bus.Interface,
  ) {
    const md = yield* Effect.tryPromise({
      try: () => ConfigMarkdown.parse(match),
      catch: (err) => err,
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (err) {
          const message = ConfigMarkdown.FrontmatterError.isInstance(err)
            ? err.data.message
            : `Failed to parse domain ${match}`
          const { Session } = yield* Effect.promise(() => import("@/session"))
          const { NamedError } = yield* Effect.promise(() => import("@opencode-ai/util/error"))
          yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
          log.error("failed to load domain", { domain: match, err })
          return undefined
        }),
      ),
    )

    if (!md) return

    const data = {
      ...md.data,
      prompt: md.content.trim() || undefined,
    }
    const parsed = Info.safeParse(data)
    if (!parsed.success) {
      log.warn("invalid domain", { path: match, issues: parsed.error.issues })
      return
    }

    if (state.domains[parsed.data.name]) {
      log.warn("duplicate domain name", {
        name: parsed.data.name,
        existing: match,
      })
    }

    state.domains[parsed.data.name] = parsed.data
  })

  const scan = Effect.fnUntraced(function* (
    state: State,
    bus: Bus.Interface,
    root: string,
    pattern: string,
  ) {
    const matches = yield* Effect.tryPromise({
      try: () =>
        Glob.scan(pattern, {
          cwd: root,
          absolute: true,
          include: "file",
          symlink: true,
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) => {
        log.error("failed to scan domains", { dir: root, error })
        return Effect.succeed([] as string[])
      }),
    )

    yield* Effect.forEach(matches, (match) => load(state, match, bus), {
      concurrency: "unbounded",
      discard: true,
    })
  })

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const bus = yield* Bus.Service

      const state = yield* InstanceState.make(
        Effect.fn("Domain.state")(function* () {
          const s: State = { domains: {} }

          const dirs = yield* config.directories()
          for (const dir of dirs) {
            yield* scan(s, bus, dir, DOMAIN_PATTERN)
          }

          const cfg = yield* config.get()
          if (cfg.domains) {
            for (const [key, val] of Object.entries(cfg.domains)) {
              if (s.domains[key]) {
                s.domains[key] = { ...s.domains[key], ...val, name: key }
              } else {
                s.domains[key] = { ...val, name: key }
              }
            }
          }

          // ensure fallback exists
          if (!s.domains[FALLBACK.name]) {
            s.domains[FALLBACK.name] = FALLBACK
          }

          log.info("init", { count: Object.keys(s.domains).length })
          return s
        }),
      )

      const get = Effect.fn("Domain.get")(function* (name: string) {
        const s = yield* InstanceState.get(state)
        return s.domains[name]
      })

      const all = Effect.fn("Domain.all")(function* () {
        const s = yield* InstanceState.get(state)
        return Object.values(s.domains)
      })

      const names = Effect.fn("Domain.names")(function* () {
        const s = yield* InstanceState.get(state)
        return Object.keys(s.domains)
      })

      const fb = Effect.fn("Domain.fallback")(function* () {
        const s = yield* InstanceState.get(state)
        return s.domains[FALLBACK.name] ?? FALLBACK
      })

      return Service.of({ get, all, names, fallback: fb })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(Bus.layer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(name: string) {
    return runPromise((svc) => svc.get(name))
  }

  export async function all() {
    return runPromise((svc) => svc.all())
  }

  export async function names() {
    return runPromise((svc) => svc.names())
  }
}
