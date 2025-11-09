// /common/league-switcher.js
import { getCurrentLeague, setCurrentLeague } from '../js/firebase-init.js';

export function createLeagueSwitcher() {
    const container = document.createElement('div');
    container.className = 'league-switcher';
    container.innerHTML = `
        <div class="league-switcher-container">
            <button id="major-league-btn" class="league-btn active">
                Major League
            </button>
            <button id="minor-league-btn" class="league-btn">
                Minor League
            </button>
        </div>
    `;

    // Add event listeners
    container.querySelector('#major-league-btn').addEventListener('click', () => {
        setCurrentLeague('major');
        updateActiveButton('major');
    });

    container.querySelector('#minor-league-btn').addEventListener('click', () => {
        setCurrentLeague('minor');
        updateActiveButton('minor');
    });

    // Update active button styling
    function updateActiveButton(league) {
        container.querySelectorAll('.league-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        container.querySelector(`#${league}-league-btn`).classList.add('active');
    }

    // Initialize with current league
    updateActiveButton(getCurrentLeague());

    return container;
}
