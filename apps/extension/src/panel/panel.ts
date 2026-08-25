import { mount } from 'svelte';
import PanelRoot from './PanelRoot.svelte';
import './styles.css';

const target = document.querySelector('#app');

if (!target) throw new Error('Svelte Lens panel mount target is missing');

mount(PanelRoot, { target });
