import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface FileChange {
  filePath: string;
  hash: string;
  exists: boolean;
}

export class Watcher {
  private fileHashes: Map<string, string> = new Map();

  async scanForChanges(directories: string[]): Promise<FileChange[]> {
    const currentFiles = new Map<string, string>();
    const changes: FileChange[] = [];

    for (const dir of directories) {
      if (!fs.existsSync(dir)) continue;
      
      const xmlFiles = await this.findXMLFiles(dir);
      
      for (const filePath of xmlFiles) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const hash = computeHash(content);
        currentFiles.set(filePath, hash);

        const oldHash = this.fileHashes.get(filePath);
        
        if (!oldHash || oldHash !== hash) {
          changes.push({ filePath, hash, exists: true });
        }
      }
    }

    // Detect deleted files — but only within the scanned directories.
    // Replacing the entire map would lose hashes for unscanned directories (e.g.
    // when notifyFileChange triggers a single-directory incremental scan), causing
    // every other file to appear new on the next full poll.
    const normalizedDirs = directories.map(d => d.endsWith(path.sep) ? d : d + path.sep);
    for (const [filePath, hash] of this.fileHashes.entries()) {
      if (!currentFiles.has(filePath)) {
        const isInScannedDir = normalizedDirs.some(d => filePath.startsWith(d));
        if (isInScannedDir) {
          changes.push({ filePath, hash, exists: false });
        }
      }
    }

    // Merge: update hashes for scanned files without discarding other directories.
    for (const change of changes) {
      if (!change.exists) {
        this.fileHashes.delete(change.filePath);
      }
    }
    for (const [filePath, hash] of currentFiles.entries()) {
      this.fileHashes.set(filePath, hash);
    }

    return changes;
  }

  private async findXMLFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    
    const walk = async (currentDir: string) => {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.xml')) {
          files.push(fullPath);
        }
      }
    };
    
    await walk(dir);
    return files;
  }

  /**
   * Pre-populate fileHashes from the persisted DB state so unchanged files are
   * skipped during the first scanForChanges() after a VS Code reopen.
   */
  seedFromDB(hashes: Map<string, string>): void {
    for (const [filePath, hash] of hashes) {
      this.fileHashes.set(filePath, hash);
    }
    console.log(`[Watcher] Seeded ${hashes.size} file hashes from DB`);
  }

  getFileHash(filePath: string): string | undefined {
    return this.fileHashes.get(filePath);
  }
}
