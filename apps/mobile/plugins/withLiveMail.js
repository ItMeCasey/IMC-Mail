// Config plugin for "Live mail": declares the foreground service that react-native-background-actions runs, so Android lets
// the app keep a connection open to each mail server while the screen is off. The library has no Expo plugin of its own.
const { withAndroidManifest } = require('expo/config-plugins')

const SERVICE = 'com.asterinet.react.bgactions.RNBackgroundActionsTask'

module.exports = function withLiveMail(config) {
  return withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application?.[0]
    if (!app) return c
    app.service ??= []
    const have = app.service.find((s) => s.$['android:name'] === SERVICE)
    if (have) have.$['android:foregroundServiceType'] = 'dataSync'
    else app.service.push({ $: { 'android:name': SERVICE, 'android:foregroundServiceType': 'dataSync' } })
    return c
  })
}
