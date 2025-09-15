import { diskStorage } from 'multer';
import * as path from 'path';
import * as os from 'os';

export const multerConfig = {
  storage: diskStorage({
    destination: os.tmpdir(), // Save files to the system's temp folder
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const extension = path.extname(file.originalname) || '.webm';
      cb(null, file.fieldname + '-' + uniqueSuffix + extension);
    },
  }),
};
