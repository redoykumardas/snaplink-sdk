import { mkdir } from "fs/promises";
import path from "path";

export class ScreenshotService {
  constructor(engine) {
    this.engine = engine;
  }

  async capture(name) {
    const config = this.engine.config.debug ?? {};
    if (!config.screenshots || !this.engine.bot?.page) return null;

    const directory = config.directory ?? ".snapchat-debug";
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${Date.now()}-${name}.png`);
    await this.engine.bot.screenshot({ path: filePath });
    return filePath;
  }
}
