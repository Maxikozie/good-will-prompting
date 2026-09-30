import { resetVault } from './index';

const { pages } = resetVault();
console.error(`[trustlayer] vault rebuilt from data/mock: ${pages} wiki pages (raw copies kept, content-addressed)`);
