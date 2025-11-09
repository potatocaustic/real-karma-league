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

    // Add event listeners
    container.querySelector('#major-league-btn').addEventListener('click', () => {
        setCurrentLeague('major');
        updateActiveButton('major');
        updateHeaderText('major');
    });

    container.querySelector('#minor-league-btn').addEventListener('click', () => {
        setCurrentLeague('minor');
        updateActiveButton('minor');
        updateHeaderText('minor');
    });

    // Update active button styling
    function updateActiveButton(league) {
        container.querySelectorAll('.league-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        container.querySelector(`#${league}-league-btn`).classList.add('active');
    }

    // Initialize with current league
    const currentLeague = getCurrentLeague();
    updateActiveButton(currentLeague);
    updateHeaderText(currentLeague);

    return container;
}
