import path, { dirname, join } from 'path'
import process from 'process'

import fs from 'fs-extra'

import { normalizedCacheDir, restoreCache, saveCache } from './helpers/cache'
import { checkGatsbyConfig, mutateConfig, spliceConfig } from './helpers/config'
import { checkEnvironment } from './helpers/environment'

// eslint-disable-next-line no-template-curly-in-string
const lmdbCacheString = 'process.cwd(), `.cache/${cacheDbFile}`'
// eslint-disable-next-line no-template-curly-in-string
const replacement = "require('os').tmpdir(), 'gatsby', `.cache/${cacheDbFile}`"

async function patchFile(baseDir): Promise<void> {
  const bundleFile = join(baseDir, '.cache', 'query-engine', 'index.js')
  // eslint-disable-next-line node/no-sync
  if (!fs.existsSync(bundleFile)) {
    return
  }
  const bundle = await fs.readFile(bundleFile, 'utf8')

  //  I'm so, so sorry
  await fs.writeFile(bundleFile, bundle.replace(lmdbCacheString, replacement))
}

const DEFAULT_FUNCTIONS_SRC = 'netlify/functions'

export async function onPreBuild({
  constants: { PUBLISH_DIR },
  utils,
  netlifyConfig,
}): Promise<void> {
  // print a helpful message if the publish dir is misconfigured
  if (!PUBLISH_DIR || process.cwd() === PUBLISH_DIR) {
    utils.build.failBuild(
      `Gatsby sites must publish the public directory, but your site’s publish directory is set to “${PUBLISH_DIR}”. Please set your publish directory to your Gatsby site’s public directory.`,
    )
  }
  // Only run in CI
  if (process.env.NETLIFY) {
    await checkEnvironment({ utils })
  }
  await restoreCache({ utils, publish: PUBLISH_DIR })
  const CACHE_DIR = normalizedCacheDir(PUBLISH_DIR)

  // Work around Gatsby bug https://github.com/gatsbyjs/gatsby/issues/33262
  await fs.ensureDir(join(CACHE_DIR, 'json'))

  checkGatsbyConfig({ utils, netlifyConfig })
}

export async function onBuild({
  constants: {
    PUBLISH_DIR,
    FUNCTIONS_SRC = DEFAULT_FUNCTIONS_SRC,
    INTERNAL_FUNCTIONS_SRC,
  },
  netlifyConfig,
}): Promise<void> {
  const CACHE_DIR = normalizedCacheDir(PUBLISH_DIR)
  const compiledFunctionsDir = path.join(CACHE_DIR, '/functions')
  // eslint-disable-next-line node/no-sync
  if (!fs.existsSync(compiledFunctionsDir)) {
    return
  }

  const functionsSrcDir = INTERNAL_FUNCTIONS_SRC || FUNCTIONS_SRC

  // copying Netlify wrapper function into functions directory

  await Promise.all(
    ['api', 'dsg', 'ssr'].map((func) =>
      fs.copy(
        path.join(__dirname, '..', 'src', 'templates', func),
        path.join(functionsSrcDir, `__${func}`),
      ),
    ),
  )

  if (
    INTERNAL_FUNCTIONS_SRC &&
    // eslint-disable-next-line node/no-sync
    fs.existsSync(path.join(FUNCTIONS_SRC, 'gatsby'))
  ) {
    console.log(`
Detected the function "${path.join(
      FUNCTIONS_SRC,
      'gatsby',
    )}" that seem to have been generated by an old version of the Essential Gatsby plugin. 
The plugin no longer uses this and it should be deleted to avoid conflicts.\n`)
  }

  mutateConfig({ netlifyConfig, CACHE_DIR, compiledFunctionsDir })

  await spliceConfig({
    startMarker: '# @netlify/plugin-gatsby start',
    endMarker: '# @netlify/plugin-gatsby end',
    contents: `GATSBY_PRECOMPILE_DEVELOP_FUNCTIONS=true`,
    fileName: join(PUBLISH_DIR, '..', '.env.development'),
  })

  const root = dirname(netlifyConfig.build.publish)
  await patchFile(root)

  // Editing _redirects to it works with ntl dev
  spliceConfig({
    startMarker: '# @netlify/plugin-gatsby redirects start',
    endMarker: '# @netlify/plugin-gatsby redirects end',
    contents: '/api/* /.netlify/functions/__api 200',
    fileName: join(netlifyConfig.build.publish, '_redirects'),
  })

  netlifyConfig.redirects.push({
    from: '/*',
    to: '/.netlify/functions/__dsg',
    status: 200,
  })
}

export async function onPostBuild({
  constants: { PUBLISH_DIR },
  utils,
}): Promise<void> {
  await saveCache({ publish: PUBLISH_DIR, utils })
}
