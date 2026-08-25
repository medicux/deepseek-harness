/**
 * The web-search card's staged form over the `web-search` settings namespace.
 *
 * The card chooses the search backend (native or external) and edits the
 * fields that backend uses; the plugin rejects writes naming fields the
 * selected provider ignores, so the card stages only what applies. The key is
 * the one control that does not live in the section: its literal never rides a
 * response, so the card learns only whether one is configured and writes it
 * through the credentials domain, addressed by the reference the section
 * names. It is still staged with the rest of the form, so one save covers
 * everything the card shows.
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm, numberField, selectField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the configurable search provider mount. Spelled here rather
 * than imported: a client package must not depend on a Host package.
 */
export const WEB_SEARCH_NS = 'web-search'

/** The backends the plugin can mount, in select order. */
export const WEB_SEARCH_PROVIDERS = ['deepseek', 'claude', 'gemini', 'exa', 'brave', 'duckduckgo', 'perplexity'] as const

/** Default credential reference per provider — mirrors the plugin's defaults; `undefined` marks the keyless backend. */
const DEFAULT_API_KEY_REF: Record<string, string | undefined> = {
  deepseek: 'DEEPSEEK_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  exa: 'EXA_API_KEY',
  brave: 'BRAVE_API_KEY',
  duckduckgo: undefined,
  perplexity: 'PERPLEXITY_API_KEY',
}

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey'

/**
 * Which backends each section field applies to — mirrors the plugin's
 * validator table for exactly the fields this card edits, so a provider
 * switch can pre-clear what a save would otherwise be refused for.
 */
const FIELD_PROVIDERS: Readonly<Record<'baseURL' | 'model' | 'maxUses', readonly string[]>> = {
  baseURL: ['deepseek', 'claude', 'gemini', 'exa', 'brave', 'perplexity'],
  model: ['deepseek', 'claude', 'gemini', 'perplexity'],
  maxUses: ['deepseek', 'claude'],
}

/** The search-provider fields this card edits. */
export interface WebSearchSettings {
  /** Which backend serves searches; blank inherits the composition layer. */
  provider?: string
  /** Credential reference naming the environment key. */
  apiKeyEnv?: string
  /** Provider endpoint; blank inherits the backend default. */
  baseURL?: string
  /** Model name for model-mediated backends; blank inherits the backend default. */
  model?: string
  /** Maximum native server-tool uses within one request. */
  maxUses?: number
}

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials.set` can affect it; false disables the control. */
  writable: boolean
}

/** What the web-search card renders. */
export interface WebSearchCardState extends CardShell {
  /** The selected backend. */
  provider: CardFieldState
  /** Provider endpoint. */
  baseURL: CardFieldState
  /** Model name for model-mediated backends. */
  model: CardFieldState
  /** Searches allowed within one native request. */
  maxUses: CardFieldState
  /** Whether the selected backend takes a key at all. */
  keyVisible: boolean
  /** The staged credential, which starts blank on every load. */
  apiKey: CardFieldState
  /** Whether the Host reports a credential configured for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
  /**
   * Fields the last provider switch pre-cleared because the chosen backend
   * would refuse them; empty unless one switch staged clears.
   */
  clearedBySwitch: ReadonlyArray<'baseURL' | 'model' | 'maxUses'>
}

/** The registration-side face the web-search card's slot entry injects. */
export interface WebSearchCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useWebSearchCard. */
    webSearchCard: SnapshotStore<WebSearchCardState>
  }
}

/** Bridges the `web-search` scope and the credentials domain onto the card. */
export class WebSearchCardController {
  private readonly form: CardForm<WebSearchSettings>
  private readonly store: SnapshotStore<WebSearchCardState>
  private credential: CredentialState = { ref: '', configured: false, writable: true }
  private clearedBySwitch: ReadonlyArray<'baseURL' | 'model' | 'maxUses'> = []

  /**
   * @param scope - the bound settings scope for the `web-search` namespace.
   * @param api - wire face used for the credential the section references.
   */
  constructor(
    private readonly scope: SettingsScope<WebSearchSettings>,
    private readonly api: Pick<IApiClient, 'credentials'>,
  ) {
    this.form = new CardForm(
      scope,
      [
        selectField('provider', [...WEB_SEARCH_PROVIDERS]),
        textField('baseURL'),
        textField('model'),
        numberField('maxUses', { min: 1, integer: true }),
      ],
      [{ field: API_KEY_FIELD, write: text => this.writeKey(text) }],
    )
    this.store = this.form.bind(() => this.projection())
    scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  private projection(): WebSearchCardState {
    const provider = this.selectedProvider()
    return {
      ...this.form.shell(),
      provider: this.form.field('provider'),
      baseURL: this.form.field('baseURL'),
      model: this.form.field('model'),
      maxUses: this.form.field('maxUses'),
      keyVisible: DEFAULT_API_KEY_REF[provider] !== undefined,
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
      clearedBySwitch: this.clearedBySwitch,
    }
  }

  /** The backend the effective section selects (defaulting like the plugin does). */
  private selectedProvider(): string {
    const staged = this.stagedProvider() ?? this.effectiveSection().provider
    return staged !== undefined && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(staged)
      ? staged
      : 'deepseek'
  }

  /** A staged provider edit wins so the card previews the form as it would save. */
  private stagedProvider(): string | undefined {
    const state = this.form.field('provider')
    return state.overridden ? state.text : undefined
  }

  private effectiveSection(): WebSearchSettings {
    const snapshot = this.scope.getSnapshot()
    return snapshot.value ?? {}
  }

  /**
   * Ask the credentials domain about the reference the section currently names.
   *
   * The answer is stored with the reference it describes: `apiKeyEnv` can
   * change between the request and its response, and two reads can settle out
   * of order, so a response is published only while it still answers for the
   * reference in force.
   */
  private async readCredential(): Promise<void> {
    const ref = refOf(this.scope.getSnapshot(), this.stagedProvider())
    if (ref === '') return
    if (ref !== this.credential.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim
      // the key is configured under a name nobody has checked.
      this.credential = { ref, configured: false, writable: true }
      this.store.set(this.projection())
    }
    let response: Awaited<ReturnType<IApiClient['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe({ refs: [ref] })
    } catch (_credentialReadFailure) {
      // The card stays usable without this: the key control simply reports the
      // last state it knew, and a write still reaches the Host.
      return
    }
    if (!response.result.ok || ref !== refOf(this.scope.getSnapshot(), this.stagedProvider())) return
    const view = response.result.value.credentials[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      // An unknown reference is treated as writable: the control stays usable
      // and the Host is what refuses, rather than the card guessing a refusal.
      writable: view?.writable ?? true,
    }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.store.set(this.projection())
  }

  /**
   * Re-read after the Host reports a change to the reference this card watches.
   *
   * A key can be written from somewhere else — the Models page addresses the
   * same reference — and the settings section does not change when it is, so
   * without this the badge keeps reporting a state the Host already replaced.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): WebSearchCardFace {
    const actions = this.form.actions()
    return {
      hooks: { webSearchCard: this.store },
      edit: (field, text) => {
        if (field === 'provider') this.switchProvider(text)
        else this.clearedBySwitch = []
        actions.edit(field, text)
      },
      resetField: actions.resetField,
      save: () => {
        this.clearedBySwitch = []
        actions.save()
      },
      discard: () => {
        this.clearedBySwitch = []
        actions.discard()
      },
    }
  }

  /**
   * Pre-clear overrides the chosen backend would refuse: the plugin rejects
   * any write naming a field the selected provider ignores, so keeping them
   * staged would deadlock the save. Only fields that carry an override — or a
   * staged edit — are cleared; inherited values stay untouched.
   * @param provider - the freshly staged backend choice.
   */
  private switchProvider(provider: string): void {
    const cleared: Array<'baseURL' | 'model' | 'maxUses'> = []
    for (const [field, providers] of Object.entries(FIELD_PROVIDERS)) {
      const name = field as keyof typeof FIELD_PROVIDERS
      if (providers.includes(provider)) continue
      if (this.form.field(name).overridden) {
        this.form.actions().resetField(name)
        cleared.push(name)
      }
    }
    this.clearedBySwitch = cleared
  }

  /**
   * Write the staged key, then re-read whether the Host now holds one.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeKey(value: string): Promise<boolean> {
    const ref = refOf(this.scope.getSnapshot(), this.stagedProvider())
    if (ref === '') return false
    try {
      await this.api.credentials.set({ ref, value })
    } catch (_credentialWriteFailure) {
      // Refusals surface through the re-read below: the Host is the only
      // authority on whether the key now exists.
    }
    await this.readCredential()
    return this.credential.configured
  }
}

/**
 * The credential reference the section names, or the selected provider's
 * default; empty when the selected backend is keyless and no control exists.
 * @param snapshot - the current scope snapshot.
 * @param stagedProvider - the staged provider choice, when one stands.
 * @returns the reference to address, or the empty string.
 */
function refOf(snapshot: SettingsScopeSnapshot<WebSearchSettings>, stagedProvider: string | undefined): string {
  const declared = snapshot.value?.apiKeyEnv
  if (declared !== undefined && declared.length > 0) return declared
  const provider = stagedProvider ?? snapshot.value?.provider
  return DEFAULT_API_KEY_REF[provider ?? 'deepseek'] ?? ''
}
