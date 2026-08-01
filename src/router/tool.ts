import fs  from 'fs';
import  path from 'path';

/**
 * 同步写入JSON对象到文件
 * @param {Object} jsonData - JSON对象
 * @param {string} directory - 目录路径
 * @param {string} filename - 文件名
 * @param {boolean} pretty - 是否格式化
 * @returns {string} 文件路径
 */
export function writeJsonToFileSync(jsonData: any, directory: string, filename = 'data.json', pretty = true) {
    // 确保目录存在
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }

    const filePath = path.join(directory, filename);
    const jsonString = pretty 
        ? JSON.stringify(jsonData, null, 2)
        : JSON.stringify(jsonData);

    fs.writeFileSync(filePath, jsonString, 'utf8');
    return filePath;
}

// // 使用示例
// try {
//     const data = { message: "Hello World", timestamp: Date.now() };
//     const filePath = writeJsonToFileSync(data, './output', 'hello.json');
//     console.log(`文件已保存: ${filePath}`);
// } catch (error) {
//     console.error('写入失败:', error.message);
// }