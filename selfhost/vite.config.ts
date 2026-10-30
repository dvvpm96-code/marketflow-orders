import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
export default defineConfig({root:path.join(root,'selfhost'),publicDir:path.join(root,'public'),plugins:[react()],resolve:{alias:{'@':root}},define:{'import.meta.env.VITE_SELFHOST':JSON.stringify('1')},build:{outDir:path.join(root,'work/selfhost-release/client'),emptyOutDir:true}});
