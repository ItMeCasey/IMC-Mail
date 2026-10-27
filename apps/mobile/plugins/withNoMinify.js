const { withGradleProperties } = require('expo/config-plugins')

/**
 * Release builds shrink the app with R8, which strips the Room database class WorkManager looks up by name,
 * so the app dies at launch. Leave shrinking off: the APK is larger, and it starts.
 */
module.exports = (config) =>
  withGradleProperties(config, (c) => {
    const set = (key, value) => {
      c.modResults = c.modResults.filter((p) => !(p.type === 'property' && p.key === key))
      c.modResults.push({ type: 'property', key, value })
    }
    set('android.enableMinifyInReleaseBuilds', 'false')
    set('android.enableShrinkResourcesInReleaseBuilds', 'false')
    return c
  })
