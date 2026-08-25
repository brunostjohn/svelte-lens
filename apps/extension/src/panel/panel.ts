import { mount } from 'svelte';
import App from './App.svelte';
import './styles.css';

const target = document.querySelector('#app');

if (!target) throw new Error('Svelte Lens panel mount target is missing');

mount(App, { target });
