// electron-vite's ?asset suffix gives the path of a bundled file.
declare module '*?asset' {
  const path: string
  export default path
}
