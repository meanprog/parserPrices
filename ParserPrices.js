const axios = require('axios');
const fs = require('fs');
    const async = require('async'); // Для ограничения количества параллельных запросов
    
    const EXPORT_URL = 'https://market.csgo.com/api/full-export/RUB.json';
    const FILE_PREFIX = 'https://market.csgo.com/api/full-export/';
    const OUTPUT_FILE = 'Skins.txt';
    
    // Пул API ключей
    const API_KEYS = [
        
    ];
    
    let itemPricesMap = new Map();
    let currentKeyIndex = 0; // Индекс текущего API ключа
    
    // Функция для получения текущего API ключа
    const getApiKey = () => {
        const apiKey = API_KEYS[currentKeyIndex];
        currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length; // Циклический выбор API ключа
        return apiKey;
    };
    
    // Функция для задержки
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    
    // Функция для получения медианы
    const calculateMedian = arr => {
        const sorted = arr.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    
    // Функция для получения информации о ценах по предмету
    const getItemPriceInfo = async (marketHashName) => {
        const apiKey = getApiKey(); // Берём текущий API ключ
        const url = `https://market.csgo.com/api/v2/get-list-items-info?key=${apiKey}&list_hash_name[]=${encodeURIComponent(marketHashName)}`;
    
        try {
            const response = await axios.get(url);
            return response.data.data[marketHashName];
        } catch (error) {
            console.error(`Error fetching price info for ${marketHashName}:`, error);
            return null;
        }
    };
    
    // Функция для получения скорректированной цены
    const getAdjustedPriceForItem = async (marketHashName) => {
        const itemInfo = await getItemPriceInfo(marketHashName);
        if (!itemInfo || !itemInfo.history) return null;
    
        const prices = itemInfo.history.map(entry => parseFloat(entry[1]));
        const medianPrice = calculateMedian(prices);
    
        return medianPrice * 0.9; // Корректируем до 92.5% от медианы
    };
    
    // Функция для записи данных в файл
    const saveToFile = () => {
        const outputData = Array.from(itemPricesMap.entries())
            .map(([name, price]) => `${name}^${price.toFixed(2)}`)
            .join('\n');
    
        fs.writeFileSync(OUTPUT_FILE, outputData, 'utf8');
        console.log('Все данные успешно записаны в Skins.txt');
    };
    
    // Основная функция для обработки цен с использованием параллелизма и задержки
    const processPrices = async (minPrice, maxPrice) => {
        try {
            const { data } = await axios.get(EXPORT_URL);
            if (!data || !data.success) throw new Error('Failed to retrieve price list');
    
            const uniqueItems = new Set();
    
            // Ограничиваем количество параллельных запросов (например, 5 одновременно)
            const queue = async.queue(async (fileName, callback) => {
                try {
                    const itemData = await axios.get(`${FILE_PREFIX}${fileName}`);
                    
                    const promises = itemData.data.map(async (item) => {
                        const marketHashName = item[2];
    
                        if (marketHashName.startsWith("Sticker |") || uniqueItems.has(marketHashName)) return;
    
                        uniqueItems.add(marketHashName);
    
                        const adjustedPrice = await getAdjustedPriceForItem(marketHashName);
                        if (adjustedPrice !== null && adjustedPrice >= minPrice && adjustedPrice <= maxPrice) {
                            itemPricesMap.set(marketHashName, adjustedPrice);
                            console.log(`${marketHashName}^${adjustedPrice.toFixed(2)}`);
                        }
    
                        // Задержка между запросами (например, 200-300 мс)
                        await delay(10000);
                    });
    
                    await Promise.all(promises);
                    callback();
                } catch (error) {
                    console.error(`Error processing file ${fileName}:`, error);
                    callback(error);
                }
            }, 5); // Одновременно 5 потоков
    
            // Добавляем задания в очередь
            data.items.forEach(fileName => queue.push(fileName));
    
            // Дожидаемся завершения всех задач
            await queue.drain();
    
            saveToFile(); // Сохраняем файл после обработки
        } catch (error) {
            console.error('Произошла ошибка:', error.message);
            saveToFile(); // Сохраняем файл в случае ошибки
        }
    };
    
    // Обработчик для завершения процесса
    const handleExit = () => {
        console.log('Процесс завершён. Сохраняем данные в файл...');
        saveToFile();
        process.exit();
    };
    
    // Установка обработчиков сигналов
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);
    
    // Задаем диапазон цен
    const MIN_PRICE = 700;
    const MAX_PRICE = 10000;
    
    // Запускаем основной процесс
    processPrices(MIN_PRICE, MAX_PRICE);
    
