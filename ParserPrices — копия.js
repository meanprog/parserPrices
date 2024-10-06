const axios = require('axios');
const fs = require('fs');
const async = require('async'); // Для ограничения количества параллельных запросов

const EXPORT_URL = 'https://market.csgo.com/api/full-export/RUB.json';
const FILE_PREFIX = 'https://market.csgo.com/api/full-export/';
const OUTPUT_FILE = 'Skins.txt';

// Пул API ключей
const API_KEYS = [
    '25Zlbh7ae4o8snvO30822pgpL0sots7',
    'cCh6MtwbeH49fwYm5O96tZ3mLH5eXXe',
    '7H43SerSd60fYnjOzSAZ8d9HOCPt3f4',
    '6Mb3jPzSRDmBdA5f8AcY1TzppUEcTzB',
    'm0iSl07zQ31R8HK1Fg0Qh4UT9U94gfk',
    'l90r7zCca004KgN66w3vSZ3R799K9wC',
    '9T9Xpb5PvcG4367tLUZ8eo29h38kaS2',
    'tXTJp47K9wAU85Yrt5drVI69fB9s21s',
    'Iewh6mjztQ43e8e3uraW7I751NjhJs7',
    'SPNBra7rC3FddV9f7HBOE9F7NMc4v57'    
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

// Функция для запроса "bid-ask" и получения самой большой цены на покупку
const getBidAskPrice = async (marketHashName, phase = '') => {
    const apiKey = await getApiKey();
    const url = `https://market.csgo.com/api/v2/bid-ask?key=${apiKey}&hash_name=${encodeURIComponent(marketHashName)}&phase=${phase}`;

    try {
        const response = await axios.get(url);
        const { bid, ask } = response.data;

        let highestBid = null;
        let lowestAsk = null;
        if (bid && bid.length > 0) {
            highestBid = Math.max(...bid.map(order => parseFloat(order.price)));
        }
        if (ask && ask.length > 0) {
            lowestAsk = Math.min(...ask.map(order => parseFloat(order.price)));
        }
        return { highestBid, lowestAsk };   
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.log('Слишком много запросов. Ждем 1 минуту перед повторной попыткой...');
            await delay(60000); // Пауза в 1 минуту
            return getBidAskPrice(marketHashName, phase); // Повторить запрос
        }
        console.error(`Ошибка при получении bid-ask для ${marketHashName}:`, error);
        return null;
    }
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

// Функция для получения скорректированной цены на основе медианы и ордеров
const getAdjustedPriceForItem = async (marketHashName, phase = '') => {
    const itemInfo = await getItemPriceInfo(marketHashName);
    if (!itemInfo || !itemInfo.history) return null;

    const history = itemInfo.history;

    // Отбрасываем предметы с малой историей продаж (например, менее 5 продаж)
    if (history.length < 5) {
        console.log(`${marketHashName} пропущен из-за малого количества продаж (${history.length})`);
        return null;
    }

    // Преобразуем историю в формат [дата, цена] и сортируем по дате
    const sales = history.map(entry => ({
        date: new Date(entry[0] * 1000), // API возвращает дату в виде Unix timestamp
        price: parseFloat(entry[1])
    }));

    // Проверяем частоту продаж — вычисляем промежутки между продажами
    let saleIntervals = [];
    for (let i = 1; i < sales.length; i++) {
        const daysBetweenSales = (sales[i].date - sales[i - 1].date) / (1000 * 60 * 60 * 24); // Промежуток в днях
        saleIntervals.push(daysBetweenSales);
    }

    // Если максимальный промежуток между продажами больше 30 дней — пропускаем этот предмет
    const maxDaysBetweenSales = Math.max(...saleIntervals);
    if (maxDaysBetweenSales > 30) {
        console.log(`${marketHashName} пропущен из-за редких продаж (максимальный промежуток ${maxDaysBetweenSales} дней)`);
        return null;
    }

    // Вычисляем медианную цену
    const prices = sales.map(sale => sale.price);
    const medianPrice = calculateMedian(prices);

    // Получаем текущую цену ордеров (bid-ask)
    const { highestBid, lowestAsk } = await getBidAskPrice(marketHashName, phase);

    // Если нет данных по ордерам, используем только медианную цену
    if (highestBid === null && lowestAsk === null) {
        console.log(`${marketHashName}: Нет данных по ордерам, возвращаем медианную цену ${medianPrice.toFixed(2)}`);
        itemPricesMap.set(marketHashName, medianPrice);
        return medianPrice;
    }

    // Логика корректировки цены с учетом диапазона
    let adjustedPrice = medianPrice;
    if (highestBid !== null) {
        if (medianPrice > highestBid * 1.10) {
            adjustedPrice = highestBid * 1.05;
            console.log(`${marketHashName}: Медианная цена ${medianPrice.toFixed(2)} выше на 10% от самого высокого ордера ${highestBid.toFixed(2)}. Устанавливаем цену ${adjustedPrice.toFixed(2)}.`);
        }
    }

    if (lowestAsk !== null) {
        if (lowestAsk - medianPrice < lowestAsk * 0.10) {
            adjustedPrice = lowestAsk * 0.90;
            console.log(`${marketHashName}: Устанавливаем цену ${adjustedPrice.toFixed(2)} (10% ниже от минимальной цены)`);
        }
    }

    // Проверка диапазона цен
    if (adjustedPrice >= MIN_PRICE && adjustedPrice <= MAX_PRICE) {
        itemPricesMap.set(marketHashName, adjustedPrice);
        return adjustedPrice;
    } else {
        console.log(`${marketHashName}: Установленная цена ${adjustedPrice.toFixed(2)} вне диапазона (${MIN_PRICE} - ${MAX_PRICE}).`);
        return null; // Возвращаем null, если цена не в диапазоне
    }
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
                    const phase = ''; // Можно задать фазу, если это необходимо
                    
                    if (marketHashName.startsWith("Sticker |") || uniqueItems.has(marketHashName) || marketHashName.startsWith("Souvenir") ) return;

                    uniqueItems.add(marketHashName);

                    const adjustedPrice = await getAdjustedPriceForItem(marketHashName, phase);
                    if (adjustedPrice !== null) {
                        itemPricesMap.set(marketHashName, adjustedPrice);
                        console.log(`${marketHashName}^${adjustedPrice.toFixed(2)}`);
                    }

                    // Задержка между запросами (например, 10 секунд)
                    await delay(10000);
                });

                await Promise.all(promises);
                callback();
            } catch (error) {
                console.error(`Error processing file ${fileName}:`, error);
                callback(error);
            }
        }, 10); // Одновременно 5 потоков

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
