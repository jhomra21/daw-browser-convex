import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

import EffectShell from '~/components/effects/EffectShell'
import { DeviceCollapseProvider } from './create-effects-panel-device-collapse'

const scenarios: Record<string, boolean> = {}

const [collapsed, setCollapsed] = createSignal(false)
const [nativeLimit, setNativeLimit] = createSignal<string>()
const host = document.createElement('div')

document.body.append(host)

render(() => (
  <DeviceCollapseProvider
    collapsed={collapsed}
    toggle={() => setCollapsed((value) => !value)}
    contentId={() => 'device-content-fixture'}
    canWrite={() => true}
    nativeLimit={nativeLimit}
  >
    <EffectShell title="Fixture device" typeLabel="Effect">
      <p id="device-body">Body</p>
    </EffectShell>
  </DeviceCollapseProvider>
), host)

const fold = () => host.querySelector('button[aria-controls="device-content-fixture"]')
const content = () => host.querySelector('#device-content-fixture')
const notice = () => host.querySelector('[role="status"]')

scenarios['expanded-device-offers-fold'] =
  fold()?.getAttribute('aria-label') === 'Fold device'
  && fold()?.getAttribute('aria-expanded') === 'true'
  && content() instanceof HTMLElement && !content()?.hasAttribute('hidden')

fold()?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

scenarios['fold-click-hides-the-body-and-offers-unfold'] =
  fold()?.getAttribute('aria-label') === 'Unfold device'
  && fold()?.getAttribute('aria-expanded') === 'false'
  && content()?.hasAttribute('hidden') === true

fold()?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

scenarios['unfold-click-restores-the-body'] =
  fold()?.getAttribute('aria-expanded') === 'true' && content()?.hasAttribute('hidden') === false

scenarios['no-limit-shows-no-notice'] = notice() === null

setNativeLimit('The native engine cannot carry this routing yet.')

scenarios['native-limit-is-a-neutral-status-with-the-reason'] =
  notice()?.textContent === 'Not supported yet'
  && notice()?.getAttribute('title')?.includes('The native engine cannot carry this routing yet.') === true
  && host.querySelector('[role="dialog"], [role="alertdialog"]') === null

setCollapsed(true)

scenarios['folded-device-hides-the-notice'] = notice() === null

const title = host.querySelector('[data-effect-shell-header] > div span')

title?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))

scenarios['double-click-on-the-title-unfolds'] = fold()?.getAttribute('aria-expanded') === 'true'

Object.defineProperty(window, '__browserFixtureResults', { value: scenarios })
