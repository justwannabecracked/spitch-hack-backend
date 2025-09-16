import { diskStorage } from 'multer';
import * as path from 'path';
import * as os from 'os';

// This configuration tells Multer to reliably save uploaded files to the
// operating system's standard temporary directory.
export const multerConfig = {
  storage: diskStorage({
    destination: os.tmpdir(), // Save files to the system's temp folder
    filename: (req, file, cb) => {
      // Create a unique filename to prevent conflicts
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const extension = path.extname(file.originalname) || '.webm';
      cb(null, 'upload-' + uniqueSuffix + extension);
    },
  }),
};
