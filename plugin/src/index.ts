import path from 'path'
import process from 'process'
import 'abortcontroller-polyfill/dist/abortcontroller-polyfill-only'

import { NetlifyPluginOptions } from '@netlify/build'
import { stripIndent } from 'common-tags'
import { existsSync } from 'fs-extra'
import fetch from 'node-fetch'

import { normalizedCacheDir, restoreCache, saveCache } from './helpers/cache'
import {
  createMetadataFileAndCopyDatastore,
  checkConfig,
  getNeededFunctions,
  modifyConfig,
  shouldSkipBundlingDatastore,
} from './helpers/config'
import { modifyFiles } from './helpers/files'
import { deleteFunctions, writeFunctions } from './helpers/functions'
import { checkZipSize } from './helpers/verification'

const DEFAULT_FUNCTIONS_SRC = 'netlify/functions'

export async function onPreBuild({
  constants,
  utils,
  netlifyConfig,
}): Promise<void> {
  const { PUBLISH_DIR } = constants
  // Print a helpful message if the publish dir is misconfigured
  if (!PUBLISH_DIR || process.cwd() === path.resolve(PUBLISH_DIR)) {
    utils.build.failBuild(
      `Gatsby sites must publish the "public" directory, but your site’s publish directory is set to “${PUBLISH_DIR}”. Please set your publish directory to your Gatsby site’s "public" directory.`,
    )
  }
  await restoreCache({ utils, publish: PUBLISH_DIR })

  await checkConfig({ utils, netlifyConfig })
}

export async function onBuild({
  constants,
  netlifyConfig,
}: NetlifyPluginOptions): Promise<void> {
  const {
    PUBLISH_DIR,
    FUNCTIONS_SRC = DEFAULT_FUNCTIONS_SRC,
    INTERNAL_FUNCTIONS_SRC,
  } = constants
  const cacheDir = normalizedCacheDir(PUBLISH_DIR)

  if (
    INTERNAL_FUNCTIONS_SRC &&
    existsSync(path.join(FUNCTIONS_SRC, 'gatsby'))
  ) {
    console.log(stripIndent`
    Detected the function "${path.join(
      FUNCTIONS_SRC,
      'gatsby',
    )}" that seem to have been generated by an old version of the Essential Gatsby plugin. 
The plugin no longer uses this and it should be deleted to avoid conflicts.\n`)
  }

  const neededFunctions = await getNeededFunctions(cacheDir)

  await deleteFunctions(constants)

  if (shouldSkipBundlingDatastore()) {
    console.log('Creating site data metadata file')
    await createMetadataFileAndCopyDatastore(PUBLISH_DIR, cacheDir)
  }

  await writeFunctions({ constants, netlifyConfig, neededFunctions })

  await modifyConfig({ netlifyConfig, cacheDir, neededFunctions })

  await modifyFiles({ netlifyConfig, neededFunctions })
}

export async function onPostBuild({
  constants: { PUBLISH_DIR, FUNCTIONS_DIST },
  utils,
}): Promise<void> {
  await saveCache({ publish: PUBLISH_DIR, utils })

  const cacheDir = normalizedCacheDir(PUBLISH_DIR)

  const neededFunctions = await getNeededFunctions(cacheDir)

  for (const func of neededFunctions) {
    await checkZipSize(path.join(FUNCTIONS_DIST, `__${func.toLowerCase()}.zip`))
  }
}

export async function onSuccess() {
  // Pre-warm the lambdas as downloading the datastore file can take a while
  if (shouldSkipBundlingDatastore()) {
    const FETCH_TIMEOUT = 5000
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, FETCH_TIMEOUT)

    for (const func of ['api', 'dsg', 'ssr']) {
      const url = `${process.env.URL}/.netlify/functions/__${func}`
      console.log(`Sending pre-warm request to: ${url}`)

      try {
        await fetch(url, { signal: controller.signal })
      } catch (error) {
        console.log('Pre-warm request was aborted', error)
      } finally {
        clearTimeout(timeout)
      }
    }
  }
}
