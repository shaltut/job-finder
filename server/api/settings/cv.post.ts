import { patchConfig } from '../../utils/config'
import { isPdf, MAX_CV_BYTES, storeCv } from '../../utils/cv'

/**
 * Upload the CV. The scoring model reads this PDF and every draft attaches it, so it has to be a
 * real PDF on disk — which is why the bytes are checked here rather than trusting the client.
 *
 * This writes the `cv` field behind the Settings form's back, so the page must refresh after a
 * successful upload; otherwise the next Save sends a stale `cv` and overwrites this path.
 */
export default defineEventHandler(async (event) => {
  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' && p.filename)
  if (!file) throw createError({ statusCode: 400, message: 'no file uploaded' })

  if (file.data.length > MAX_CV_BYTES) {
    const mb = (file.data.length / 1024 / 1024).toFixed(1)
    throw createError({ statusCode: 413, message: `that file is ${mb} MB; the limit is 10 MB` })
  }
  if (!isPdf(file.data)) {
    throw createError({ statusCode: 400, message: 'that file is not a PDF' })
  }

  const { path, bytes } = storeCv(file.filename!, file.data)
  const config = patchConfig({ cv: path })
  console.log(`[settings] CV stored at ${path} (${bytes} bytes)`)
  return { config, cv: path, bytes }
})
