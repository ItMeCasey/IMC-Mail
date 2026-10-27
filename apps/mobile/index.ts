// Hermes has no Web Crypto; the shared sync code needs crypto.subtle. This must run before anything else.
import { install } from 'react-native-quick-crypto'

install()

import { registerRootComponent } from 'expo'
import App from './App'

registerRootComponent(App)
