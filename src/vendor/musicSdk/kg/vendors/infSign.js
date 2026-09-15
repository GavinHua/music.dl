import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const infSign = require('./infSign.min.js')

export default infSign
