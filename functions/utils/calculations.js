// functions/utils/calculations.js

/**
 * Calculates the median of an array of numbers
 * @param {number[]} numbers - Array of numbers
 * @returns {number} The median value
 */
function calculateMedian(numbers) {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middleIndex = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
    }
    return sorted[middleIndex];
}

/**
 * Calculates the arithmetic mean (average) of an array of numbers
 * @param {number[]} numbers - Array of numbers
 * @returns {number} The mean value
 */
function calculateMean(numbers) {
    if (!numbers || numbers.length === 0) return 0;
    const sum = numbers.reduce((acc, val) => acc + val, 0);
    return sum / numbers.length;
}

/**
 * Calculates the geometric mean of an array of numbers
 * Filters out zero and negative values before calculation
 * @param {number[]} numbers - Array of numbers
 * @returns {number} The geometric mean value
 */
function calculateGeometricMean(numbers) {
    if (numbers.length === 0) return 0;
    const nonZeroNumbers = numbers.filter(num => num > 0);
    if (nonZeroNumbers.length === 0) return 0;
    const product = nonZeroNumbers.reduce((prod, num) => prod * num, 1);
    return Math.pow(product, 1 / nonZeroNumbers.length);
}

module.exports = {
    calculateMedian,
    calculateMean,
    calculateGeometricMean
};
