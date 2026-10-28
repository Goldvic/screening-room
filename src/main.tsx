import { createRoot } from 'react-dom/client';
import App from './App';
// @ts-expect-error CSS side-effect imports are handled by the bundler.
import './styles.css';
// @ts-ignore CSS side-effect imports are handled by the bundler.
import './redesign.css';
// @ts-ignore CSS side-effect imports are handled by the bundler.
import './premium.css';

createRoot(document.getElementById('root')!).render(<App />);