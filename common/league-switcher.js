// /common/league-switcher.js
import { getCurrentLeague, setCurrentLeague } from '../js/firebase-init.js';

export function createLeagueSwitcher() {
    const container = document.createElement('div');
    container.className = 'league-switcher';
    container.innerHTML = `
        <button id="league-toggle-btn" class="league-toggle-btn" aria-label="Toggle League" title="Switch League">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="17 1 21 5 17 9"></polyline>
                <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                <polyline points="7 23 3 19 7 15"></polyline>
                <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
            </svg>
        </button>
    `;

    // Function to update header text based on league
    function updateHeaderText(league) {
        const headerTextElement = document.querySelector('.header-text');
        if (headerTextElement) {
            if (league === 'major') {
                headerTextElement.textContent = ' Real Karma League';
            } else if (league === 'minor') {
                headerTextElement.textContent = ' Real Karma Minor League';
            }
        }
    }

    // Function to update header logo based on league
    function updateHeaderLogo(league) {
        const headerLogoElement = document.querySelector('.header-logo');
        if (headerLogoElement) {
            if (league === 'major') {
                headerLogoElement.src = '../icons/RKL.webp';
                headerLogoElement.alt = 'RKL Logo';
            } else if (league === 'minor') {
                headerLogoElement.src = '../icons/RKML.webp';
                headerLogoElement.alt = 'RKML Logo';
            }
        }
    }

    // Toggle league on button click
    container.querySelector('#league-toggle-btn').addEventListener('click', () => {
        const currentLeague = getCurrentLeague();
        const newLeague = currentLeague === 'major' ? 'minor' : 'major';
        setCurrentLeague(newLeague);
        updateHeaderText(newLeague);
        updateHeaderLogo(newLeague);
    });

    // Initialize with current league
    const currentLeague = getCurrentLeague();
    updateHeaderText(currentLeague);
    updateHeaderLogo(currentLeague);

    return container;
}
