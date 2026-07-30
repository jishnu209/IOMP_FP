import { Provider } from '@react-spectrum/s2'
import { style } from '@react-spectrum/s2/style' with { type: 'macro' }
import { useEffect, useState } from 'react'

// Using the S2 `style()` macro here on purpose: it forces the
// unplugin-parcel-macros → Vite pipeline to run, so if the build boots we know
// the S2 styling toolchain is wired correctly.
const providerStyles = style({
  minHeight: 'screen',
})

/**
 * App-wide React Spectrum S2 Provider.
 *
 * Phase 0: this establishes the Spectrum theming context (light/dark, Adobe
 * design tokens, Adobe Clean font) around the existing app. The legacy Proxy
 * theme (`P`) still drives colors inside components for now; it will be retired
 * in Phase 1 as components move to S2 tokens.
 */
export function AppProvider({ children }) {
  const read = () =>
    (typeof localStorage !== 'undefined' && localStorage.getItem('nexus_theme')) === 'dark'
      ? 'dark'
      : 'light'
  const [scheme, setScheme] = useState(read)
  // Keep the Provider's colorScheme in sync with runtime theme toggles so all
  // React Spectrum components (Switch, Meter, TextField, …) restyle to dark/light.
  useEffect(() => {
    const onChange = () => setScheme(read())
    window.addEventListener('nexusthemechange', onChange)
    return () => window.removeEventListener('nexusthemechange', onChange)
  }, [])
  return (
    <Provider colorScheme={scheme} background="base" styles={providerStyles}>
      {children}
    </Provider>
  )
}
