/**
 * The web-search card: the backend choice, the fields that backend uses, and
 * the key — which is written through the credentials domain, never into the
 * settings section, so the literal never rides a response.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SecretField, SelectField, ValueField } from './fields.tsx'
import cardCss from './PluginCard.module.css'
import { PluginCard } from './PluginCard.tsx'
import { WEB_SEARCH_PROVIDERS, type WebSearchCardFace } from './web-search-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the web-search card. */
export type WebSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebSearchCardFace>

/** Backend choices in select order; proper nouns need no translation. */
const PROVIDER_OPTIONS = WEB_SEARCH_PROVIDERS.map(value => ({
  value,
  label: value === 'duckduckgo' ? 'DuckDuckGo' : value.charAt(0).toUpperCase() + value.slice(1),
}))

/** Model-mediated backends expose a model-name field. */
const MODEL_PROVIDERS = new Set(['deepseek', 'claude', 'gemini', 'perplexity'])

/** Backends whose searches carry a native server-tool budget. */
const MAX_USES_PROVIDERS = new Set(['deepseek', 'claude'])

/** Locale keys naming the clearable section fields, for the switch notice. */
const FIELD_LABELS = {
  baseURL: 'webSearchBaseUrl',
  model: 'webSearchModel',
  maxUses: 'webSearchMaxUses',
} as const

/**
 * Render the web-search card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  const disabled = !state.writable
  const provider = (WEB_SEARCH_PROVIDERS as readonly string[]).includes(state.provider.text)
    ? state.provider.text
    : 'deepseek'
  // An inherited provider renders as the value a save would store, not blank.
  const providerText = state.provider.text === '' ? 'deepseek' : state.provider.text
  const switchNotice = state.clearedBySwitch.length > 0
    ? `${t('webSearchSwitchCleared')} ${state.clearedBySwitch.map(field => t(FIELD_LABELS[field])).join(', ')}`
    : null
  // The key plane belongs to keyed backends only; a keyless backend hides it,
  // including its endpoint field.
  const keySection = !state.keyVisible
    ? null
    : (
      <>
        <SecretField
          id="plugin-config-web-search-key"
          label={t('webSearchApiKey')}
          hint={t('webSearchApiKeyHint')}
          // The credentials domain accepts a key even when the settings
          // document itself is read-only; they are separate stores with
          // separate refusals. Its own writability is what disables this
          // control — a key sourced from the process environment cannot be
          // written from here.
          disabled={!state.apiKeyWritable}
          text={state.apiKey.text}
          configured={state.apiKeyConfigured}
          stateLabel={state.apiKeyConfigured ? t('webSearchApiKeySet') : t('webSearchApiKeyUnset')}
          onEdit={(text) => { props.edit('apiKey', text) }}
        />
        <ValueField
          id="plugin-config-web-search-endpoint"
          label={t('webSearchBaseUrl')}
          hint={t('webSearchBaseUrlHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalidNumber')}
          disabled={disabled}
          {...state.baseURL}
          onEdit={(text) => { props.edit('baseURL', text) }}
          onReset={() => { props.resetField('baseURL') }}
        />
      </>
    )
  const modelField = MODEL_PROVIDERS.has(provider)
    ? (
      <ValueField
        id="plugin-config-web-search-model"
        label={t('webSearchModel')}
        hint={t('webSearchModelHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.model}
        onEdit={(text) => { props.edit('model', text) }}
        onReset={() => { props.resetField('model') }}
      />
    )
    : null
  const maxUsesField = MAX_USES_PROVIDERS.has(provider)
    ? (
      <ValueField
        id="plugin-config-web-search-max-uses"
        label={t('webSearchMaxUses')}
        hint={t('webSearchMaxUsesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxUses}
        onEdit={(text) => { props.edit('maxUses', text) }}
        onReset={() => { props.resetField('maxUses') }}
      />
    )
    : null
  return (
    <PluginCard
      t={t}
      titleKey="webSearchTitle"
      descriptionKey="webSearchDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SelectField
        id="plugin-config-web-search-provider"
        label={t('webSearchProvider')}
        hint={t('webSearchProviderHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        text={providerText}
        overridden={state.provider.overridden}
        invalid={state.provider.invalid}
        options={PROVIDER_OPTIONS}
        onEdit={(text) => { props.edit('provider', text) }}
        onReset={() => { props.resetField('provider') }}
      />
      {switchNotice !== null && <p className={cardCss.switchNotice}>{switchNotice}</p>}
      {keySection}
      {modelField}
      {maxUsesField}
    </PluginCard>
  )
}
